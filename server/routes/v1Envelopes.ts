import { Router } from "express";
import crypto from "crypto";
import { storage } from "../storage";
import { db } from "../db";
import { createApiEnvelopeRequestSchema } from "@shared/schema";
import { uploadFile, deleteFile, downloadFile } from "../fileStorage";
import { getPageCount } from "../services/PdfService";
import { generateToken } from "../services/SecurityService";
import { sendSigningInvitation, loadEmailSettings } from "../services/NotificationService";
import { emitEvent } from "../services/EventDispatcher";
import { ContactService } from "../services/ContactService";
import { asyncHandler } from "../middleware/asyncHandler";
import { apiKeyAuth } from "../middleware/apiKeyAuth";
import { rateLimit } from "../middleware/rateLimit";

const PDF_FETCH_TIMEOUT_MS = 60_000;
const PDF_MAX_BYTES = 25 * 1024 * 1024;
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
const EXPIRES_AT_FLOOR_MS = 60_000;

function signedUrlSecret(): string {
  const secret = process.env.ARCHISIGN_SIGNED_URL_SECRET || process.env.ARCHISIGN_WEBHOOK_SECRET;
  if (!secret) {
    // Refuse to mint or verify URLs with a guessable secret. Operators must
    // set ARCHISIGN_SIGNED_URL_SECRET (or fall through to ARCHISIGN_WEBHOOK_SECRET).
    // Both `status` and `statusCode` are set so that the global error middleware
    // (`err.status || err.statusCode`) surfaces this as a 503.
    console.error("[v1Envelopes] CRITICAL: ARCHISIGN_SIGNED_URL_SECRET (or ARCHISIGN_WEBHOOK_SECRET) is not configured; refusing to mint /signed-pdf-fetch URL");
    throw Object.assign(
      new Error("Signed-URL secret is not configured on this server"),
      { status: 503, statusCode: 503 },
    );
  }
  return secret;
}

export function mintSignedPdfUrl(envelopeId: number, baseUrl: string): { url: string; expiresAt: string } {
  const exp = Date.now() + SIGNED_URL_TTL_MS;
  const sig = crypto.createHmac("sha256", signedUrlSecret())
    .update(`${envelopeId}.${exp}`)
    .digest("hex");
  const url = `${baseUrl}/api/v1/envelopes/${envelopeId}/signed-pdf-fetch?exp=${exp}&sig=${sig}`;
  return { url, expiresAt: new Date(exp).toISOString() };
}

function verifySignedPdfUrl(envelopeId: number, exp: string, sig: string): boolean {
  const expNum = Number.parseInt(exp, 10);
  if (!Number.isFinite(expNum) || Date.now() > expNum) return false;
  const expected = crypto.createHmac("sha256", signedUrlSecret())
    .update(`${envelopeId}.${exp}`)
    .digest("hex");
  if (expected.length !== sig.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

async function fetchPdfFromUrl(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`pdfFetchUrl returned ${response.status}`), { httpStatus: 400 });
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > PDF_MAX_BYTES) {
    throw Object.assign(new Error("PDF exceeds 25 MiB limit"), { httpStatus: 413 });
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.byteLength > PDF_MAX_BYTES) {
    throw Object.assign(new Error("PDF exceeds 25 MiB limit"), { httpStatus: 413 });
  }
  return buf;
}

function buildAccessUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/sign/${token}`;
}

export function buildV1EnvelopesRouter(): Router {
  const router = Router();

  router.use(apiKeyAuth);

  /**
   * POST /api/v1/envelopes/create — §3.5.1
   */
  router.post("/envelopes/create", rateLimit("create"), asyncHandler(async (req, res) => {
    const parsed = createApiEnvelopeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", fieldErrors: parsed.error.flatten().fieldErrors });
    }
    const data = parsed.data;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    if (data.expiresAt) {
      const expMs = new Date(data.expiresAt).getTime();
      if (!Number.isFinite(expMs) || expMs < Date.now() + EXPIRES_AT_FLOOR_MS) {
        return res.status(400).json({ error: "invalid_request", message: "expiresAt must be at least 1 minute in the future" });
      }
    }

    let savedPdfUrl: string | null = data.pdfUrl || null;
    let totalPages = 1;
    let mintedFromFetch = false;

    if (data.pdfFetchUrl) {
      try {
        const buf = await fetchPdfFromUrl(data.pdfFetchUrl);
        totalPages = await getPageCount(buf);
        const fileName = `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`;
        savedPdfUrl = await uploadFile(fileName, buf);
        mintedFromFetch = true;
      } catch (err: any) {
        const status = err.httpStatus || (err.name === "TimeoutError" ? 400 : 503);
        const code = status === 413 ? "pdf_too_large" : status === 503 ? "vault_transient" : "pdf_fetch_failed";
        return res.status(status).json({ error: code, message: err.message });
      }
    } else if (data.pdfBase64) {
      let buf: Buffer;
      try {
        buf = Buffer.from(data.pdfBase64, "base64");
        totalPages = await getPageCount(buf);
      } catch (err: any) {
        return res.status(400).json({ error: "invalid_pdf", message: err.message });
      }
      if (buf.byteLength > PDF_MAX_BYTES) {
        return res.status(413).json({ error: "pdf_too_large", message: "PDF exceeds 25 MiB limit" });
      }
      const fileName = `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`;
      savedPdfUrl = await uploadFile(fileName, buf);
      mintedFromFetch = true;
    }

    const signerList = (data.signers && data.signers.length > 0)
      ? data.signers
      : [{ email: data.signerEmail!, fullName: data.signerName || data.signerEmail! }];

    const subject = data.subject || "Document for signature";

    let envelope: { id: number; createdAt: Date; expiresAt: Date | null; status: string };
    let createdSigners: Array<{ id: number; accessToken: string; email: string }>;
    try {
      const result = await db.transaction(async (tx) => {
        const env = await storage.createEnvelope({
          subject,
          externalRef: data.externalRef || null,
          webhookUrl: data.webhookUrl || null,
          originalPdfUrl: savedPdfUrl,
          signedPdfUrl: null,
          totalPages,
          status: "draft",
          gmailThreadId: null,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
          origin: data.origin || req.apiKeyAuth!.tenant,
        } as any, tx);

        const signers: Array<{ id: number; accessToken: string; email: string }> = [];
        for (const s of signerList) {
          const token = generateToken();
          const created = await storage.createSigner({
            envelopeId: env.id,
            email: s.email,
            fullName: s.fullName,
            accessToken: token,
          }, tx);
          signers.push({ id: created.id, accessToken: token, email: s.email });
        }

        await storage.createAuditEvent({
          envelopeId: env.id,
          eventType: "Envelope created via API",
          actorEmail: null,
          ipAddress: req.ip || null,
          metadata: JSON.stringify({
            tenant: req.apiKeyAuth!.tenant,
            signerCount: signerList.length,
            pdfSource: data.pdfFetchUrl ? "pdfFetchUrl" : data.pdfBase64 ? "pdfBase64" : "pdfUrl",
            externalRef: data.externalRef || null,
          }),
        }, tx);

        return { env, signers };
      });
      envelope = result.env;
      createdSigners = result.signers;
      try {
        await ContactService.bumpLastUsed(createdSigners.map(s => s.email));
      } catch (bumpErr: any) {
        console.warn(`[v1.create] bumpLastUsed failed for envelope ${envelope.id}: ${bumpErr?.message || bumpErr}`);
      }
    } catch (txErr) {
      if (savedPdfUrl && mintedFromFetch) {
        await deleteFile(savedPdfUrl).catch(() => {});
      }
      throw txErr;
    }

    res.status(201).json({
      envelopeId: envelope.id,
      status: envelope.status,
      createdAt: envelope.createdAt,
      expiresAt: envelope.expiresAt,
      signers: createdSigners.map(s => ({
        id: s.id,
        accessToken: s.accessToken,
        accessUrl: buildAccessUrl(baseUrl, s.accessToken),
        otpDestination: s.email,
      })),
    });
  }));

  /**
   * POST /api/v1/envelopes/:envelopeId/send — §3.5.2 idempotent
   *
   * On first call: dispatches signer invitation emails, transitions the
   * envelope to `sent`, and emits a single `envelope.sent` webhook (per §3.7
   * single-receiver). On re-send while in {sent,viewed,queried}: 200 with the
   * original sentAt and no side-effects. On terminal {signed,declined,expired,
   * void}: 409.
   */
  router.post("/envelopes/:envelopeId/send", rateLimit("send"), asyncHandler(async (req, res) => {
    const envelopeId = Number.parseInt(req.params.envelopeId, 10);
    if (!Number.isFinite(envelopeId)) {
      return res.status(400).json({ error: "invalid_request", message: "envelopeId must be an integer" });
    }
    const envelope = await storage.getEnvelope(envelopeId);
    if (!envelope) {
      return res.status(404).json({ error: "envelope_not_found" });
    }

    const terminalStates = new Set(["signed", "declined", "expired", "void"]);
    if (terminalStates.has(envelope.status)) {
      return res.status(409).json({
        error: "envelope_terminal",
        envelopeId,
        status: envelope.status,
        message: `Envelope is in terminal state '${envelope.status}'; /send is non-idempotent past terminal`,
      });
    }

    const idempotentStates = new Set(["sent", "viewed", "queried"]);
    const wasAlreadySent = idempotentStates.has(envelope.status);

    if (wasAlreadySent) {
      const refreshed = await storage.getEnvelope(envelopeId);
      return res.status(200).json({
        envelopeId,
        status: refreshed?.status ?? envelope.status,
        sentAt: envelope.updatedAt,
      });
    }

    // Race-tight transition: only one caller transitions draft → sent.
    // Concurrent callers fall through to the idempotent 200 branch with no
    // duplicate emails or webhook emissions.
    const sentAt = new Date();
    const claimed = await storage.atomicClaimEnvelopeSend(envelopeId, sentAt);
    if (!claimed) {
      const refreshed = await storage.getEnvelope(envelopeId);
      const refreshedStatus = refreshed?.status ?? "sent";
      if (terminalStates.has(refreshedStatus)) {
        return res.status(409).json({
          error: "envelope_terminal",
          envelopeId,
          status: refreshedStatus,
          message: `Envelope is in terminal state '${refreshedStatus}'; /send is non-idempotent past terminal`,
        });
      }
      return res.status(200).json({
        envelopeId,
        status: refreshedStatus,
        sentAt: refreshed?.updatedAt ?? sentAt,
      });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const emailCfg = await loadEmailSettings();

    const emailResults: { signerId: number; success: boolean; threadId: string | null; error: string | null }[] = [];
    for (const signer of envelope.signers) {
      try {
        const r = await sendSigningInvitation(
          { email: signer.email, fullName: signer.fullName, accessToken: signer.accessToken },
          { id: envelope.id, subject: envelope.subject, externalRef: envelope.externalRef, message: envelope.message, gmailThreadId: envelope.gmailThreadId },
          baseUrl,
          emailCfg,
        );
        emailResults.push({ signerId: signer.id, success: true, threadId: r.threadId ?? null, error: null });
      } catch (err: any) {
        emailResults.push({ signerId: signer.id, success: false, threadId: null, error: err?.message || String(err) });
      }
    }

    // Status was already transitioned by atomicClaimEnvelopeSend above; we only
    // record the audit event here (post-side-effects so emailResults are captured).
    await storage.createAuditEvent({
      envelopeId,
      eventType: "Envelope sent via API",
      actorEmail: null,
      ipAddress: req.ip || null,
      metadata: JSON.stringify({
        tenant: req.apiKeyAuth!.tenant,
        idempotencyKey: req.headers["idempotency-key"] || null,
        emailResults,
      }),
    });

    if (envelope.webhookUrl) {
      try {
        await emitEvent({
          webhookUrl: envelope.webhookUrl,
          envelope: { id: envelope.id, externalRef: envelope.externalRef, origin: envelope.origin },
          eventData: {
            event: "envelope.sent",
            signers: envelope.signers.map(s => ({ email: s.email, name: s.fullName })),
          },
          occurredAt: sentAt,
          tenantKey: envelope.origin || undefined,
        });
      } catch (err: any) {
        console.error(`[v1.send] envelope.sent emit failed for envelope ${envelopeId}: ${err?.message || err}`);
      }
    }

    const refreshed = await storage.getEnvelope(envelopeId);
    res.status(200).json({
      envelopeId,
      status: refreshed?.status ?? "sent",
      sentAt,
    });
  }));

  /**
   * GET /api/v1/envelopes/:envelopeId/signed-pdf-url — §3.5.3
   */
  router.get("/envelopes/:envelopeId/signed-pdf-url", rateLimit("read"), asyncHandler(async (req, res) => {
    const envelopeId = Number.parseInt(req.params.envelopeId, 10);
    if (!Number.isFinite(envelopeId)) {
      return res.status(400).json({ error: "invalid_request", message: "envelopeId must be an integer" });
    }
    const envelope = await storage.getEnvelope(envelopeId);
    if (!envelope) {
      return res.status(404).json({ error: "envelope_not_found" });
    }

    if (envelope.retentionBreachAt) {
      // Use the latest signedAt across signers as the authoritative
      // originalSignedAt (§3.8 retention_breach body).
      const signedAtCandidates = envelope.signers
        .map(s => s.signedAt)
        .filter((d): d is Date => !!d);
      const originalSignedAt = signedAtCandidates.length > 0
        ? new Date(Math.max(...signedAtCandidates.map(d => d.getTime()))).toISOString()
        : envelope.updatedAt.toISOString();
      return res.status(410).json({
        error: "retention_breach",
        envelopeId,
        originalSignedAt,
        detectedAt: (envelope.retentionDetectedAt ?? envelope.retentionBreachAt).toISOString(),
        incidentRef: envelope.retentionIncidentRef ?? "INC-UNKNOWN",
        remediationContact: process.env.ARCHISIGN_RETENTION_REMEDIATION_CONTACT || "vault-ops@archisign.fr",
      });
    }

    if (envelope.status !== "signed" || !envelope.signedPdfUrl) {
      return res.status(409).json({
        error: "envelope_not_signed",
        envelopeId,
        status: envelope.status,
      });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const { url, expiresAt } = mintSignedPdfUrl(envelopeId, baseUrl);
    res.status(200).json({ url, expiresAt });
  }));

  return router;
}

/**
 * Companion endpoint that streams the signed PDF when invoked with a valid
 * mint signature from /signed-pdf-url. NOT mounted under apiKeyAuth — the
 * HMAC sig+exp is the auth.
 */
export function buildSignedPdfFetchHandler() {
  return asyncHandler(async (req: any, res: any) => {
    const envelopeId = Number.parseInt(req.params.envelopeId, 10);
    const exp = String(req.query.exp || "");
    const sig = String(req.query.sig || "");
    if (!Number.isFinite(envelopeId) || !exp || !sig) {
      return res.status(400).json({ error: "invalid_request" });
    }
    if (!verifySignedPdfUrl(envelopeId, exp, sig)) {
      return res.status(401).json({ error: "invalid_signature_or_expired" });
    }
    const envelope = await storage.getEnvelope(envelopeId);
    if (!envelope || !envelope.signedPdfUrl) {
      return res.status(404).json({ error: "signed_pdf_not_found" });
    }
    if (envelope.retentionBreachAt) {
      return res.status(410).json({
        error: "retention_breach",
        envelopeId,
        incidentRef: envelope.retentionIncidentRef ?? "INC-UNKNOWN",
      });
    }
    const file = await downloadFile(envelope.signedPdfUrl);
    if (!file) return res.status(404).json({ error: "signed_pdf_not_found" });
    res.setHeader("Content-Type", file.contentType || "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="envelope-${envelopeId}-signed.pdf"`);
    res.send(file.data);
  });
}
