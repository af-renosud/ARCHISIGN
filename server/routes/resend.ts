import type { Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { storage as defaultStorage } from "../storage";
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
  storage: Pick<typeof defaultStorage, "getEnvelope" | "createAuditEvent">;
  sendResendInvitation: typeof defaultSendResendInvitation;
  loadEmailSettings: typeof defaultLoadEmailSettings;
  getGmailProfile: typeof defaultGetGmailProfile;
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

  return asyncHandler(async (req: Request<any>, res: Response) => {
    const id = parseInt(req.params.id);
    const envelope = await storage.getEnvelope(id);
    if (!envelope) return res.status(404).json({ message: "Envelope not found" });

    const resendableStatuses = ["sent", "viewed", "queried"];
    if (!resendableStatuses.includes(envelope.status)) {
      return res.status(400).json({ message: `Cannot resend envelope with status "${envelope.status}".` });
    }

    const resendBodySchema = z.object({
      message: z.string().max(5000).optional().nullable(),
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

    const firmEmail = await getGmailProfile();
    const emailCfg = await loadEmailSettings();
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const emailResults: { email: string; success: boolean; error?: string }[] = [];

    for (const signer of pendingSigners) {
      try {
        await sendResendInvitation(signer, envelope, baseUrl, emailCfg, customMessage);
        emailResults.push({ email: signer.email, success: true });
      } catch (err: any) {
        console.error(`Failed to resend email to ${signer.email}:`, err);
        emailResults.push({ email: signer.email, success: false, error: err.message });
      }
    }

    const allFailed = emailResults.every((r) => !r.success);
    if (allFailed) {
      await storage.createAuditEvent({
        envelopeId: id,
        eventType: "Envelope resend failed - all emails failed",
        actorEmail: (req.user as any)?.claims?.email || firmEmail || null,
        ipAddress: req.ip || null,
        metadata: JSON.stringify({ recipients: emailResults, messageIncluded: customMessage !== null }),
      });
      return res.status(502).json({ message: "Failed to resend emails to all pending signers.", failures: emailResults });
    }

    await storage.createAuditEvent({
      envelopeId: id,
      eventType: "Envelope resent to pending signers",
      actorEmail: (req.user as any)?.claims?.email || firmEmail || null,
      ipAddress: req.ip || null,
      metadata: JSON.stringify({ recipients: emailResults, messageIncluded: customMessage !== null }),
    });

    const updated = await storage.getEnvelope(id);
    res.json(updated);
  });
}
