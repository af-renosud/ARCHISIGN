import type { Envelope, SendEnvelopeRequest } from "@shared/schema";
import { storage as defaultStorage, type IStorage } from "../storage";
import {
  getGmailProfile as defaultGetGmailProfile,
  loadEmailSettings as defaultLoadEmailSettings,
  sendSigningInvitation as defaultSendSigningInvitation,
} from "./NotificationService";
import { emitEvent as defaultEmitEvent } from "./EventDispatcher";
import { placementReviewBlock } from "./PlacementReviewService";

type MessageEnvelope = Pick<Envelope, "id" | "message">;
type ClaimStorage = Pick<IStorage, "atomicClaimEnvelopeSend">;
type FullEnvelope = NonNullable<Awaited<ReturnType<IStorage["getEnvelope"]>>>;

export interface InitialEnvelopeSendDeps {
  storage: Pick<
    IStorage,
    | "getEnvelope"
    | "atomicClaimEnvelopeSend"
    | "atomicReleaseEnvelopeSend"
    | "updateEnvelope"
    | "createAuditEvent"
  >;
  getGmailProfile: typeof defaultGetGmailProfile;
  loadEmailSettings: typeof defaultLoadEmailSettings;
  sendSigningInvitation: typeof defaultSendSigningInvitation;
  emitEvent: typeof defaultEmitEvent;
}

export interface InitialEnvelopeSendInput {
  envelopeId: number;
  request: SendEnvelopeRequest;
  baseUrl: string;
  ipAddress: string | null;
}

export class InitialEnvelopeSendError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "InitialEnvelopeSendError";
  }

  toResponseBody(): Record<string, unknown> {
    return { ...this.details, message: this.message };
  }
}

/**
 * Atomically claims a draft for initial delivery and applies an explicitly
 * supplied invitation message in that same write. An omitted property
 * preserves the existing message; blank or null explicitly clears it.
 */
export async function claimEnvelopeForInitialSend<T extends MessageEnvelope>(
  envelope: T,
  request: SendEnvelopeRequest,
  claimedAt: Date,
  storage: ClaimStorage = defaultStorage,
): Promise<T | null> {
  const messageUpdate = Object.prototype.hasOwnProperty.call(request, "message")
    ? { message: request.message || null }
    : undefined;
  const claimed = await storage.atomicClaimEnvelopeSend(
    envelope.id,
    claimedAt,
    messageUpdate,
  );
  return claimed ? { ...envelope, ...claimed } : null;
}

/**
 * Complete initial-send orchestration. Keeping email and state-transition
 * logic here makes the Express route a validation/HTTP adapter only.
 */
export async function sendEnvelopeForSigning(
  input: InitialEnvelopeSendInput,
  overrides: Partial<InitialEnvelopeSendDeps> = {},
): Promise<FullEnvelope> {
  const deps: InitialEnvelopeSendDeps = {
    storage: defaultStorage,
    getGmailProfile: defaultGetGmailProfile,
    loadEmailSettings: defaultLoadEmailSettings,
    sendSigningInvitation: defaultSendSigningInvitation,
    emitEvent: defaultEmitEvent,
    ...overrides,
  };

  const storedEnvelope = await deps.storage.getEnvelope(input.envelopeId);
  if (!storedEnvelope) {
    throw new InitialEnvelopeSendError(404, "Envelope not found");
  }
  if (storedEnvelope.status !== "draft") {
    throw new InitialEnvelopeSendError(400, "Envelope already sent");
  }
  if (!storedEnvelope.originalPdfUrl) {
    throw new InitialEnvelopeSendError(
      409,
      "Envelope has no PDF document and cannot be sent",
      { code: "pdf_missing" },
    );
  }
  const placementBlock = placementReviewBlock(storedEnvelope);
  if (placementBlock) {
    throw new InitialEnvelopeSendError(409, placementBlock.message, placementBlock);
  }

  // Resolve dependencies before claiming; if settings/profile lookup fails,
  // the envelope remains an untouched draft.
  const [firmEmail, emailCfg] = await Promise.all([
    deps.getGmailProfile(),
    deps.loadEmailSettings(),
  ]);

  const claimedAt = new Date();
  const envelope = await claimEnvelopeForInitialSend(
    storedEnvelope,
    input.request,
    claimedAt,
    deps.storage,
  );
  if (!envelope) {
    const refreshed = await deps.storage.getEnvelope(input.envelopeId);
    const refreshedPlacementBlock = refreshed ? placementReviewBlock(refreshed) : null;
    if (refreshedPlacementBlock) {
      throw new InitialEnvelopeSendError(
        409,
        refreshedPlacementBlock.message,
        refreshedPlacementBlock,
      );
    }
    throw new InitialEnvelopeSendError(
      409,
      "Envelope is already being sent or has already been sent",
      { code: "send_conflict" },
    );
  }

  const emailResults: { email: string; success: boolean; error?: string }[] = [];
  for (const signer of envelope.signers) {
    try {
      const result = await deps.sendSigningInvitation(
        signer,
        envelope,
        input.baseUrl,
        emailCfg,
      );
      emailResults.push({ email: signer.email, success: true });

      if (result.threadId && !envelope.gmailThreadId) {
        // Thread persistence is secondary to successful delivery.
        try {
          await deps.storage.updateEnvelope(input.envelopeId, {
            gmailThreadId: result.threadId,
          });
        } catch (threadErr) {
          console.error(`Failed to persist Gmail thread for envelope ${input.envelopeId}:`, threadErr);
        }
      }
    } catch (err: any) {
      console.error(`Failed to send email to ${signer.email}:`, err);
      emailResults.push({
        email: signer.email,
        success: false,
        error: err?.message || String(err),
      });
    }
  }

  const allFailed = emailResults.every((result) => !result.success);
  if (allFailed) {
    const released = await deps.storage.atomicReleaseEnvelopeSend(
      input.envelopeId,
      claimedAt,
    );
    await deps.storage.createAuditEvent({
      envelopeId: input.envelopeId,
      eventType: "Envelope send failed - all emails failed",
      actorEmail: firmEmail || null,
      ipAddress: input.ipAddress,
      metadata: JSON.stringify(emailResults),
    });
    throw new InitialEnvelopeSendError(
      502,
      released
        ? "Failed to send emails to all signers. Envelope remains in draft."
        : "Failed to send emails to all signers. Envelope status could not be restored automatically.",
      { failures: emailResults },
    );
  }

  await deps.storage.createAuditEvent({
    envelopeId: input.envelopeId,
    eventType: "Envelope sent for signing",
    actorEmail: firmEmail || null,
    ipAddress: input.ipAddress,
    metadata: emailResults.some((result) => !result.success)
      ? JSON.stringify(emailResults)
      : null,
  });

  if (envelope.webhookUrl) {
    try {
      await deps.emitEvent({
        webhookUrl: envelope.webhookUrl,
        envelope: {
          id: input.envelopeId,
          externalRef: envelope.externalRef,
          origin: envelope.origin,
        },
        eventData: {
          event: "envelope.sent",
          signers: envelope.signers.map((signer) => ({
            email: signer.email,
            name: signer.fullName,
          })),
        },
        tenantKey: envelope.origin || undefined,
      });
    } catch (err: any) {
      console.error(
        `[envelope.sent] emit failure for envelope ${input.envelopeId}: ${err?.message || err}`,
      );
    }
  }

  return (await deps.storage.getEnvelope(input.envelopeId)) ?? envelope;
}