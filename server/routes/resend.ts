import type { Request, Response, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  storage as defaultStorage,
  RESEND_DELIVERY_HEARTBEAT_INTERVAL_MS,
} from "../storage";
import {
  sendResendInvitation as defaultSendResendInvitation,
  loadEmailSettings as defaultLoadEmailSettings,
  getGmailProfile as defaultGetGmailProfile,
} from "../services/NotificationService";
import { asyncHandler } from "../middleware/asyncHandler";

// Dependencies the resend handler reaches for. Defaulted to the real
// singletons/functions so production wiring stays a no-arg call, but each is
// injectable so the handler can be mounted on a throwaway Express app and
// driven in isolation (the monolithic registerRoutes() pulls in setupAuth,
// which performs live OIDC discovery and cannot run under the Node test
// harness).
export interface ResendHandlerDeps {
  storage: Pick<
    typeof defaultStorage,
    | "getEnvelope"
    | "getSignersByEnvelope"
    | "createAuditEvent"
    | "atomicClaimResendDelivery"
    | "refreshResendDeliveryClaim"
    | "releaseResendDeliveryClaim"
  >;
  sendResendInvitation: typeof defaultSendResendInvitation;
  loadEmailSettings: typeof defaultLoadEmailSettings;
  getGmailProfile: typeof defaultGetGmailProfile;
  claimHeartbeatIntervalMs: number;
}

export function buildResendHandler(
  overrides: Partial<ResendHandlerDeps> = {},
): RequestHandler {
  const storage = overrides.storage ?? defaultStorage;
  const sendResendInvitation =
    overrides.sendResendInvitation ?? defaultSendResendInvitation;
  const loadEmailSettings =
    overrides.loadEmailSettings ?? defaultLoadEmailSettings;
  const getGmailProfile = overrides.getGmailProfile ?? defaultGetGmailProfile;
  const claimHeartbeatIntervalMs =
    overrides.claimHeartbeatIntervalMs ?? RESEND_DELIVERY_HEARTBEAT_INTERVAL_MS;

  return asyncHandler(async (req: Request<any>, res: Response) => {
    const id = parseInt(req.params.id);
    const envelope = await storage.getEnvelope(id);
    if (!envelope) return res.status(404).json({ message: "Envelope not found" });

    const resendableStatuses = ["sent", "viewed", "queried"];
    if (!resendableStatuses.includes(envelope.status)) {
      return res.status(400).json({ message: `Cannot resend envelope with status "${envelope.status}".` });
    }

    // Legacy PDF-less rows must not receive fresh signing invitations.
    if (!envelope.originalPdfUrl) {
      return res.status(409).json({ code: "pdf_missing", message: "Envelope has no PDF document and cannot be sent" });
    }

    const resendBodySchema = z.object({
      message: z.string().max(5000).optional().nullable(),
      signerIds: z.array(z.number().int().positive())
        .min(1, "Select at least one signer")
        .refine((ids) => new Set(ids).size === ids.length, "Signer selections must be unique")
        .optional(),
    });
    const resendParsed = resendBodySchema.safeParse(req.body ?? {});
    if (!resendParsed.success) {
      return res.status(400).json({ message: "Invalid resend data", errors: resendParsed.error.flatten().fieldErrors });
    }
    const customMessage = resendParsed.data.message && resendParsed.data.message.trim()
      ? resendParsed.data.message.trim()
      : null;

    const pendingSigners = envelope.signers.filter((s) => !s.signedAt);
    if (pendingSigners.length === 0) {
      return res.status(400).json({ message: "All signers have already signed." });
    }

    const requestedSignerIds = resendParsed.data.signerIds;
    const signerById = new Map(envelope.signers.map((signer) => [signer.id, signer]));
    const invalidSignerIds = requestedSignerIds?.filter((signerId) => {
      const signer = signerById.get(signerId);
      return !signer || !!signer.signedAt;
    }) ?? [];
    if (invalidSignerIds.length > 0) {
      return res.status(400).json({
        message: "Selected signers must belong to this envelope and still be awaiting signature.",
        invalidSignerIds,
      });
    }
    const recipients = requestedSignerIds
      ? requestedSignerIds.map((signerId) => signerById.get(signerId)!)
      : pendingSigners;

    const firmEmail = await getGmailProfile();
    const emailCfg = await loadEmailSettings();
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const emailResults: {
      signerId: number;
      fullName: string;
      email: string;
      success: boolean;
      skipped?: boolean;
      skipReason?: "signed" | "delivery_in_progress" | "unavailable";
      error?: string;
    }[] = [];

    for (const signer of recipients) {
      const claimId = randomUUID();
      const claimedSigner = await storage.atomicClaimResendDelivery(signer.id, claimId);
      if (!claimedSigner) {
        const currentSigner = (await storage.getSignersByEnvelope(envelope.id))
          .find((candidate) => candidate.id === signer.id);
        const skipReason = currentSigner?.signedAt
          ? "signed"
          : currentSigner?.resendDeliveryClaimId
            ? "delivery_in_progress"
            : "unavailable";
        emailResults.push({
          signerId: signer.id,
          fullName: signer.fullName,
          email: signer.email,
          success: false,
          skipped: true,
          skipReason,
          error: skipReason === "signed"
            ? "Signer completed signing before the reminder was sent"
            : skipReason === "delivery_in_progress"
              ? "Another reminder delivery is already in progress"
              : "Signer is no longer available for reminder delivery",
        });
        continue;
      }
      let result: typeof emailResults[number];
      let heartbeatRunning = false;
      const heartbeat = setInterval(() => {
        if (heartbeatRunning) return;
        heartbeatRunning = true;
        void storage.refreshResendDeliveryClaim(signer.id, claimId)
          .then((refreshed) => {
            if (!refreshed) {
              console.error(`Lost resend delivery claim for signer ${signer.id}`);
            }
          })
          .catch((err) => {
            console.error(`Failed to refresh resend delivery claim for signer ${signer.id}:`, err);
          })
          .finally(() => {
            heartbeatRunning = false;
          });
      }, claimHeartbeatIntervalMs);
      heartbeat.unref();
      try {
        await sendResendInvitation(claimedSigner, envelope, baseUrl, emailCfg, customMessage);
        result = {
          signerId: claimedSigner.id,
          fullName: claimedSigner.fullName,
          email: claimedSigner.email,
          success: true,
        };
      } catch (err: any) {
        console.error(`Failed to resend email to ${claimedSigner.email}:`, err);
        result = {
          signerId: claimedSigner.id,
          fullName: claimedSigner.fullName,
          email: claimedSigner.email,
          success: false,
          error: err.message,
        };
      } finally {
        clearInterval(heartbeat);
        await storage.releaseResendDeliveryClaim(signer.id, claimId);
      }
      emailResults.push(result);
    }

    const auditMetadata = {
      recipients: emailResults,
      selectedSignerIds: recipients.map((signer) => signer.id),
      defaultedToAllPending: requestedSignerIds === undefined,
      messageIncluded: customMessage !== null,
    };
    const allSkipped = emailResults.every((result) => result.skipped);
    if (allSkipped) {
      await storage.createAuditEvent({
        envelopeId: id,
        eventType: "Envelope resend skipped - signers no longer pending",
        actorEmail: (req.user as any)?.claims?.email || firmEmail || null,
        ipAddress: req.ip || null,
        metadata: JSON.stringify(auditMetadata),
      });
      return res.status(409).json({
        message: "The selected signers are no longer available for reminder delivery.",
        skipped: emailResults,
      });
    }
    const allFailed = emailResults.every((r) => !r.success);
    if (allFailed) {
      await storage.createAuditEvent({
        envelopeId: id,
        eventType: "Envelope resend failed - all emails failed",
        actorEmail: (req.user as any)?.claims?.email || firmEmail || null,
        ipAddress: req.ip || null,
        metadata: JSON.stringify(auditMetadata),
      });
      return res.status(502).json({ message: "Failed to resend invitations to the selected signers.", failures: emailResults });
    }

    await storage.createAuditEvent({
      envelopeId: id,
      eventType: requestedSignerIds
        ? "Envelope resent to selected signers"
        : "Envelope resent to pending signers",
      actorEmail: (req.user as any)?.claims?.email || firmEmail || null,
      ipAddress: req.ip || null,
      metadata: JSON.stringify(auditMetadata),
    });

    const updated = await storage.getEnvelope(id);
    const successful = emailResults.filter((result) => result.success).length;
    const skipped = emailResults.filter((result) => result.skipped).length;
    res.json({
      ...(updated ?? envelope),
      resendResult: {
        attempted: emailResults.length,
        successful,
        failed: emailResults.length - successful - skipped,
        skipped,
        recipients: emailResults,
      },
    });
  });
}
