import type { Express, RequestHandler } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { db } from "./db";
import { sendEmail, getGmailProfile } from "./gmail";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import { insertRollbackVersionSchema, insertBackupSchema, createEnvelopeRequestSchema, createSignerRequestSchema, createApiEnvelopeRequestSchema } from "@shared/schema";
import { z } from "zod";
import { randomBytes, randomInt, createHash } from "crypto";
import multer from "multer";
import path from "path";
import fs from "fs";
import fsPromises from "fs/promises";
import { uploadFile, downloadFile, streamFileToResponse, fileExists, deleteFile, uploadBackup, downloadBackup, deleteBackupFile } from "./fileStorage";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface EmailSettings {
  registrationLine: string;
  footerText: string;
  firmName: string;
  invitationBody: string;
  otpBody: string;
  completionBody: string;
  subjectPrefix: string;
}

async function loadEmailSettings(): Promise<EmailSettings> {
  const allSettings = await storage.getAllSettings();
  const map: Record<string, string> = {};
  for (const s of allSettings) {
    map[s.key] = s.value;
  }
  return {
    registrationLine: map["email_registration_line"] || "INSCRIPTION \u00C0 L\u2019ORDRE DES ARCHITECTES OCCITANIE S24348",
    footerText: map["email_footer_text"] || "Powered by Archisign",
    firmName: map["firm_name"] || "Archisign",
    invitationBody: map["email_invitation_body"] || "You have been invited to review and sign the following document.",
    otpBody: map["email_otp_body"] || "Please use the verification code below to access the document. This code expires in 10 minutes.",
    completionBody: map["email_completion_body"] || "All parties have completed signing the document. The signed document is now available for download.",
    subjectPrefix: map["email_invitation_subject_prefix"] || "Signature Required:",
  };
}

function wrapEmail(bodyContent: string, baseUrl: string, emailCfg: EmailSettings): string {
  const firmLogoUrl = `${baseUrl}/logo.png`;
  const platformLogoUrl = `${baseUrl}/archisign-platform-logo.png`;
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
      <div style="text-align: center; padding: 24px 0 16px 0; border-bottom: 1px solid #e2e8f0;">
        <img src="${firmLogoUrl}" alt="${emailCfg.firmName}" style="max-height: 48px; border-radius: 50%;" />
      </div>
      <div style="padding: 24px;">
        ${bodyContent}
      </div>
      <div style="border-top: 1px solid #e2e8f0; padding: 16px 24px; text-align: center;">
        <p style="color: #94a3b8; font-size: 11px; margin: 0 0 8px 0;">${emailCfg.registrationLine}</p>
        <div style="margin: 8px 0 4px 0;">
          <img src="${platformLogoUrl}" alt="Archisign" style="height: 20px; opacity: 0.6;" />
        </div>
        <p style="color: #b0b8c4; font-size: 10px; margin: 0;">${emailCfg.footerText}</p>
      </div>
    </div>
  `;
}

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"));
    }
  },
});

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function generateOtp(): string {
  return randomInt(100000, 1000000).toString();
}

function hashOtp(otp: string): string {
  return createHash("sha256").update(otp).digest("hex");
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await setupAuth(app);
  registerAuthRoutes(app);

  const isAdminAuthorized: RequestHandler = (req, res, next) => {
    const p = req.path;
    if (p.startsWith("/api/sign/")) {
      return next();
    }
    if (p.startsWith("/api/v1/")) {
      const apiKey = req.headers["x-api-key"] || req.query.api_key;
      const expectedKey = process.env.ARCHIDOC_API_KEY;
      if (expectedKey && apiKey !== expectedKey) {
        console.warn(`[AUTH] Invalid API key on ${req.method} ${req.path}`);
        return res.status(401).json({ message: "Invalid or missing API key" });
      }
      if (!expectedKey) {
        console.warn(`[AUTH] ARCHIDOC_API_KEY not configured — /api/v1/* routes are unprotected`);
      }
      return next();
    }
    if (p.startsWith("/api/login") || p.startsWith("/api/logout") || p.startsWith("/api/callback") || p.startsWith("/api/auth/")) {
      return next();
    }
    if (p.startsWith("/uploads")) {
      return next();
    }
    if (p.startsWith("/api/")) {
      return isAuthenticated(req, res, () => {
        const user = req.user as any;
        const userEmail = user?.claims?.email;

        const allowedEmails = (process.env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);

        if (allowedEmails.length > 0 && (!userEmail || !allowedEmails.includes(userEmail.toLowerCase()))) {
          console.warn(`[AUTH] Unauthorized admin access attempt by ${userEmail || "unknown"} on ${req.method} ${req.path}`);
          storage.createAuditEvent({
            envelopeId: null,
            eventType: "Unauthorized admin access attempt",
            actorEmail: userEmail || "unknown",
            ipAddress: req.ip || null,
            metadata: JSON.stringify({ path: req.path, method: req.method }),
          }).catch(() => {});
          return res.status(403).json({ message: "Access denied. Your account is not authorized for admin access." });
        }

        next();
      });
    }
    next();
  };
  app.use(isAdminAuthorized);

  app.get("/api/envelopes", async (_req, res) => {
    try {
      const envs = await storage.getEnvelopes();
      res.json(envs);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/envelopes/deleted", async (_req, res) => {
    try {
      const deleted = await storage.getDeletedEnvelopes();
      res.json(deleted);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/envelopes/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const envelope = await storage.getEnvelope(id);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });
      res.json(envelope);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/envelopes", upload.single("pdf"), async (req, res) => {
    try {
      const envelopeParsed = createEnvelopeRequestSchema.safeParse(req.body);
      if (!envelopeParsed.success) {
        return res.status(400).json({ message: "Invalid envelope data", errors: envelopeParsed.error.flatten().fieldErrors });
      }
      const { subject, externalRef, webhookUrl, message } = envelopeParsed.data;

      let rawSigners: unknown[];
      try {
        rawSigners = JSON.parse(req.body.signers || "[]");
      } catch {
        return res.status(400).json({ message: "Invalid signers JSON" });
      }

      if (!Array.isArray(rawSigners) || rawSigners.length === 0) {
        return res.status(400).json({ message: "At least one signer is required" });
      }

      const signersParsed = z.array(createSignerRequestSchema).safeParse(rawSigners);
      if (!signersParsed.success) {
        return res.status(400).json({ message: "Invalid signer data", errors: signersParsed.error.flatten().fieldErrors });
      }
      const signersData = signersParsed.data;

      let pdfUrl: string | undefined;
      let totalPages = 1;
      if (req.file) {
        try {
          const ext = path.extname(req.file.originalname);
          const newName = `${req.file.filename}${ext}`;
          const pdfBytes = await fsPromises.readFile(req.file.path);
          pdfUrl = await uploadFile(newName, pdfBytes);

          try {
            const { PDFDocument } = await import("pdf-lib");
            const pdfDoc = await PDFDocument.load(pdfBytes);
            totalPages = pdfDoc.getPageCount();
          } catch {
            totalPages = 1;
          }
        } finally {
          await fsPromises.unlink(req.file.path).catch(() => {});
        }
      }

      const envelope = await db.transaction(async (tx) => {
        const env = await storage.createEnvelope({
          subject,
          externalRef: externalRef || null,
          message: message || null,
          webhookUrl: webhookUrl || null,
          originalPdfUrl: pdfUrl || null,
          signedPdfUrl: null,
          totalPages,
          status: "draft",
          gmailThreadId: null,
        }, tx);

        for (const s of signersData) {
          await storage.createSigner({
            envelopeId: env.id,
            email: s.email,
            fullName: s.fullName,
            accessToken: generateToken(),
          }, tx);
        }

        await storage.createAuditEvent({
          envelopeId: env.id,
          eventType: "Envelope created",
          actorEmail: null,
          ipAddress: req.ip || null,
          metadata: null,
        }, tx);

        return env;
      });

      const full = await storage.getEnvelope(envelope.id);
      res.json(full);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/envelopes/:id/send", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const envelope = await storage.getEnvelope(id);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });
      if (envelope.status !== "draft") return res.status(400).json({ message: "Envelope already sent" });

      const firmEmail = await getGmailProfile();
      const emailCfg = await loadEmailSettings();

      const emailResults: { email: string; success: boolean; error?: string }[] = [];

      for (const signer of envelope.signers) {
        const baseUrl = `${req.protocol}://${req.get("host")}`;
        const signingUrl = `${baseUrl}/sign/${signer.accessToken}`;
        const htmlBody = wrapEmail(`
            <h2 style="color: #1e40af; margin-top: 0;">Document Ready for Signing</h2>
            <p>Dear ${escapeHtml(signer.fullName)},</p>
            <p>${emailCfg.invitationBody}</p>
            <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 4px 0;"><strong>Subject:</strong> ${escapeHtml(envelope.subject)}</p>
              ${envelope.externalRef ? `<p style="margin: 4px 0;"><strong>Reference:</strong> ${escapeHtml(envelope.externalRef)}</p>` : ""}
              ${envelope.message ? `<p style="margin: 12px 0 4px 0; white-space: pre-line;">${escapeHtml(envelope.message)}</p>` : ""}
            </div>
            <p>Please click the button below to verify your identity and review the document:</p>
            <a href="${signingUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Review & Sign Document</a>
            <p style="margin-top: 24px; color: #64748b; font-size: 12px;">This is a secure link. Do not share it with anyone.</p>
        `, baseUrl, emailCfg);

        try {
          const result = await sendEmail(
            signer.email,
            `[${emailCfg.firmName}] ${emailCfg.subjectPrefix} ${envelope.subject}`,
            htmlBody
          );

          emailResults.push({ email: signer.email, success: true });

          if (result.threadId && !envelope.gmailThreadId) {
            await storage.updateEnvelope(id, { gmailThreadId: result.threadId });
          }
        } catch (err: any) {
          console.error(`Failed to send email to ${signer.email}:`, err);
          emailResults.push({ email: signer.email, success: false, error: err.message });
        }
      }

      const allFailed = emailResults.every(r => !r.success);
      if (allFailed) {
        await storage.createAuditEvent({
          envelopeId: id,
          eventType: "Envelope send failed - all emails failed",
          actorEmail: firmEmail || null,
          ipAddress: req.ip || null,
          metadata: JSON.stringify(emailResults),
        });
        return res.status(502).json({
          message: "Failed to send emails to all signers. Envelope remains in draft.",
          failures: emailResults,
        });
      }

      await storage.updateEnvelope(id, { status: "sent" });
      await storage.createAuditEvent({
        envelopeId: id,
        eventType: "Envelope sent for signing",
        actorEmail: firmEmail || null,
        ipAddress: req.ip || null,
        metadata: emailResults.some(r => !r.success) ? JSON.stringify(emailResults) : null,
      });

      try {
        if (envelope.webhookUrl) {
          await sendWebhook(envelope.webhookUrl, {
            event: "envelope.sent",
            envelopeId: id,
            externalRef: envelope.externalRef,
            status: "sent",
          });
        }
      } catch (err: any) {
        console.error(`Webhook delivery failed for envelope ${id}:`, err.message);
      }

      const updated = await storage.getEnvelope(id);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/envelopes/:id/resend", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const envelope = await storage.getEnvelope(id);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });

      const resendableStatuses = ["sent", "viewed", "queried"];
      if (!resendableStatuses.includes(envelope.status)) {
        return res.status(400).json({ message: `Cannot resend envelope with status "${envelope.status}".` });
      }

      const pendingSigners = envelope.signers.filter(s => !s.signedAt);
      if (pendingSigners.length === 0) {
        return res.status(400).json({ message: "All signers have already signed." });
      }

      const firmEmail = await getGmailProfile();
      const emailCfg = await loadEmailSettings();
      const emailResults: { email: string; success: boolean; error?: string }[] = [];

      for (const signer of pendingSigners) {
        const baseUrl = `${req.protocol}://${req.get("host")}`;
        const signingUrl = `${baseUrl}/sign/${signer.accessToken}`;
        const htmlBody = wrapEmail(`
            <h2 style="color: #1e40af; margin-top: 0;">Reminder: Document Awaiting Your Signature</h2>
            <p>Dear ${escapeHtml(signer.fullName)},</p>
            <p>This is a reminder that a document is still awaiting your signature.</p>
            <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 4px 0;"><strong>Subject:</strong> ${escapeHtml(envelope.subject)}</p>
              ${envelope.externalRef ? `<p style="margin: 4px 0;"><strong>Reference:</strong> ${escapeHtml(envelope.externalRef)}</p>` : ""}
            </div>
            <p>Please click the button below to verify your identity and review the document:</p>
            <a href="${signingUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Review & Sign Document</a>
            <p style="margin-top: 24px; color: #64748b; font-size: 12px;">This is a secure link. Do not share it with anyone.</p>
        `, baseUrl, emailCfg);

        try {
          await sendEmail(
            signer.email,
            `[${emailCfg.firmName}] Reminder: ${emailCfg.subjectPrefix} ${envelope.subject}`,
            htmlBody,
            envelope.gmailThreadId || undefined
          );
          emailResults.push({ email: signer.email, success: true });
        } catch (err: any) {
          console.error(`Failed to resend email to ${signer.email}:`, err);
          emailResults.push({ email: signer.email, success: false, error: err.message });
        }
      }

      const allFailed = emailResults.every(r => !r.success);
      if (allFailed) {
        await storage.createAuditEvent({
          envelopeId: id,
          eventType: "Envelope resend failed - all emails failed",
          actorEmail: (req.user as any)?.claims?.email || firmEmail || null,
          ipAddress: req.ip || null,
          metadata: JSON.stringify(emailResults),
        });
        return res.status(502).json({ message: "Failed to resend emails to all pending signers.", failures: emailResults });
      }

      await storage.createAuditEvent({
        envelopeId: id,
        eventType: "Envelope resent to pending signers",
        actorEmail: (req.user as any)?.claims?.email || firmEmail || null,
        ipAddress: req.ip || null,
        metadata: JSON.stringify({ recipients: emailResults }),
      });

      const updated = await storage.getEnvelope(id);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/envelopes/:id/reply", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { message } = req.body;
      if (!message) return res.status(400).json({ message: "Message is required" });

      const envelope = await storage.getEnvelope(id);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });

      const firmEmail = await getGmailProfile();

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const emailCfg = await loadEmailSettings();
      for (const signer of envelope.signers) {
        const htmlBody = wrapEmail(`
            <h3 style="color: #1e40af; margin-top: 0;">Response from Architect</h3>
            <p>Dear ${escapeHtml(signer.fullName)},</p>
            <p>Regarding: <strong>${escapeHtml(envelope.subject)}</strong></p>
            <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0; white-space: pre-wrap;">${escapeHtml(message)}</div>
            <p>You may continue to <a href="${baseUrl}/sign/${signer.accessToken}">review and sign the document</a>.</p>
        `, baseUrl, emailCfg);

        try {
          await sendEmail(
            signer.email,
            `Re: [${emailCfg.firmName}] ${envelope.subject}`,
            htmlBody,
            envelope.gmailThreadId || undefined
          );
        } catch (err) {
          console.error(`Failed to send reply to ${signer.email}:`, err);
        }
      }

      await storage.createCommunicationLog({
        envelopeId: id,
        senderEmail: firmEmail || "architect@firm.com",
        messageBody: message,
        isExternalQuery: false,
        gmailMessageId: null,
      });

      await storage.updateEnvelope(id, { status: "sent" });
      await storage.createAuditEvent({
        envelopeId: id,
        eventType: "Reply sent to signer query",
        actorEmail: firmEmail || null,
        ipAddress: req.ip || null,
        metadata: null,
      });

      const updated = await storage.getEnvelope(id);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/sign/:token/info", async (req, res) => {
    try {
      const signer = await storage.getSignerByToken(req.params.token);
      if (!signer) return res.status(404).json({ message: "Invalid link" });

      const envelope = await storage.getEnvelope(signer.envelopeId);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });

      res.json({
        signerName: signer.fullName,
        signerEmail: signer.email,
        envelopeSubject: envelope.subject,
        verified: signer.otpVerified,
        signed: !!signer.signedAt,
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/sign/:token/request-otp", async (req, res) => {
    try {
      const signer = await storage.getSignerByToken(req.params.token);
      if (!signer) return res.status(404).json({ message: "Invalid link" });

      const otp = generateOtp();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await storage.updateSigner(signer.id, {
        otpCode: hashOtp(otp),
        otpExpiresAt: expiresAt,
      });

      const envelope = await storage.getEnvelope(signer.envelopeId);
      const emailCfg = await loadEmailSettings();

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      try {
        await sendEmail(
          signer.email,
          `[${emailCfg.firmName}] Your verification code: ${otp}`,
          wrapEmail(`
            <h2 style="color: #1e40af; margin-top: 0;">Verification Code</h2>
            <p>Dear ${escapeHtml(signer.fullName)},</p>
            <p>${emailCfg.otpBody}</p>
            <p>Your verification code for signing "${escapeHtml(envelope?.subject || "")}" is:</p>
            <div style="background: #f8fafc; border-radius: 8px; padding: 24px; margin: 16px 0; text-align: center;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1e40af;">${otp}</span>
            </div>
            <p style="color: #64748b; font-size: 12px;">If you did not request this code, please ignore this email.</p>
          `, baseUrl, emailCfg)
        );
      } catch (err) {
        console.error("Failed to send OTP email:", err);
      }

      await storage.createAuditEvent({
        envelopeId: signer.envelopeId,
        eventType: "OTP requested",
        actorEmail: signer.email,
        ipAddress: req.ip || null,
        metadata: null,
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/sign/:token/verify-otp", async (req, res) => {
    try {
      const signer = await storage.getSignerByToken(req.params.token);
      if (!signer) return res.status(404).json({ message: "Invalid link" });

      const { code } = req.body;
      if (!code) return res.status(400).json({ message: "Code is required" });

      if (!signer.otpCode || !signer.otpExpiresAt) {
        return res.status(400).json({ message: "No OTP requested. Please request a new code." });
      }

      if (new Date() > new Date(signer.otpExpiresAt)) {
        return res.status(400).json({ message: "Code has expired. Please request a new one." });
      }

      if (signer.otpCode !== hashOtp(String(code))) {
        return res.status(400).json({ message: "Invalid code. Please try again." });
      }

      await storage.updateSigner(signer.id, {
        otpVerified: true,
        otpCode: null,
        otpExpiresAt: null,
        lastViewedAt: new Date(),
      });

      const envelope = await storage.getEnvelope(signer.envelopeId);
      if (envelope && envelope.status === "sent") {
        await storage.updateEnvelope(signer.envelopeId, { status: "viewed" });
      }

      await storage.createAuditEvent({
        envelopeId: signer.envelopeId,
        eventType: "Identity verified via OTP",
        actorEmail: signer.email,
        ipAddress: req.ip || null,
        metadata: null,
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/sign/:token/document", async (req, res) => {
    try {
      const signer = await storage.getSignerByToken(req.params.token);
      if (!signer) return res.status(404).json({ message: "Invalid link" });
      if (!signer.otpVerified) return res.status(403).json({ message: "Not verified" });

      const envelope = await storage.getEnvelope(signer.envelopeId);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });

      const existingAnnotations = await storage.getAnnotationsByEnvelopeAndSigner(envelope.id, signer.id);
      const initialedPages = existingAnnotations
        .filter(a => a.type === "initial")
        .map(a => a.pageNumber);

      res.json({
        envelope: {
          id: envelope.id,
          subject: envelope.subject,
          externalRef: envelope.externalRef,
          originalPdfUrl: envelope.originalPdfUrl,
          status: envelope.status,
          totalPages: envelope.totalPages,
        },
        signer: {
          id: signer.id,
          fullName: signer.fullName,
          email: signer.email,
          signedAt: signer.signedAt,
          authenticationId: signer.signedAt
            ? createHash("sha256").update(`${signer.id}-${envelope.id}-${signer.signedAt}`).digest("hex").substring(0, 12).toUpperCase()
            : null,
        },
        totalPages: envelope.totalPages,
        initialed: [...new Set(initialedPages)],
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/sign/:token/initial", async (req, res) => {
    try {
      const signer = await storage.getSignerByToken(req.params.token);
      if (!signer) return res.status(404).json({ message: "Invalid link" });
      if (!signer.otpVerified) return res.status(403).json({ message: "Not verified" });
      if (signer.signedAt) return res.status(400).json({ message: "Already signed" });

      const { pageNumber } = req.body;
      if (!pageNumber || typeof pageNumber !== "number") {
        return res.status(400).json({ message: "Page number is required" });
      }

      await storage.createAnnotation({
        envelopeId: signer.envelopeId,
        signerId: signer.id,
        pageNumber,
        xPos: 0.9,
        yPos: 0.95,
        type: "initial",
        value: signer.fullName.split(" ").map(n => n[0]).join("").toUpperCase(),
      });

      await storage.createAuditEvent({
        envelopeId: signer.envelopeId,
        eventType: `Page ${pageNumber} initialed`,
        actorEmail: signer.email,
        ipAddress: req.ip || null,
        metadata: null,
      });

      const existingAnnotations = await storage.getAnnotationsByEnvelopeAndSigner(signer.envelopeId, signer.id);
      const initialedPages = [...new Set(existingAnnotations.filter(a => a.type === "initial").map(a => a.pageNumber))];

      res.json({ success: true, initialed: initialedPages });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/sign/:token/query", async (req, res) => {
    try {
      const signer = await storage.getSignerByToken(req.params.token);
      if (!signer) return res.status(404).json({ message: "Invalid link" });
      if (!signer.otpVerified) return res.status(403).json({ message: "Not verified" });

      const { message } = req.body;
      if (!message) return res.status(400).json({ message: "Message is required" });

      const envelope = await storage.getEnvelope(signer.envelopeId);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });

      await storage.createCommunicationLog({
        envelopeId: envelope.id,
        senderEmail: signer.email,
        messageBody: message,
        isExternalQuery: true,
        gmailMessageId: null,
      });

      await storage.updateEnvelope(envelope.id, { status: "queried" });

      const firmEmail = await getGmailProfile();

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const emailCfg = await loadEmailSettings();
      if (firmEmail) {
        try {
          await sendEmail(
            firmEmail,
            `[${emailCfg.firmName} Query] ${envelope.subject} - from ${signer.fullName}`,
            wrapEmail(`
              <h2 style="color: #dc2626; margin-top: 0;">Clarification Request</h2>
              <div style="background: #fef2f2; border-radius: 8px; padding: 16px; margin: 16px 0;">
                <p style="margin: 4px 0;"><strong>Document:</strong> ${escapeHtml(envelope.subject)}</p>
                <p style="margin: 4px 0;"><strong>From:</strong> ${escapeHtml(signer.fullName)} (${escapeHtml(signer.email)})</p>
                ${envelope.externalRef ? `<p style="margin: 4px 0;"><strong>Reference:</strong> ${escapeHtml(envelope.externalRef)}</p>` : ""}
              </div>
              <h3>Query:</h3>
              <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0; white-space: pre-wrap;">${escapeHtml(message)}</div>
              <p style="color: #64748b; font-size: 12px;">Reply to this email or respond through the ${emailCfg.firmName} admin panel.</p>
            `, baseUrl, emailCfg),
            envelope.gmailThreadId || undefined
          );
        } catch (err) {
          console.error("Failed to forward query:", err);
        }
      }

      await storage.createAuditEvent({
        envelopeId: envelope.id,
        eventType: "Clarification requested",
        actorEmail: signer.email,
        ipAddress: req.ip || null,
        metadata: message,
      });

      if (envelope.webhookUrl) {
        try {
          await sendWebhook(envelope.webhookUrl, {
            event: "envelope.queried",
            envelopeId: envelope.id,
            externalRef: envelope.externalRef,
            status: "queried",
            queryFrom: signer.email,
            queryMessage: message,
          });
        } catch (err: any) {
          console.error(`Webhook delivery failed for envelope ${envelope.id}:`, err.message);
        }
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/sign/:token/sign", async (req, res) => {
    try {
      const signer = await storage.getSignerByToken(req.params.token);
      if (!signer) return res.status(404).json({ message: "Invalid link" });
      if (!signer.otpVerified) return res.status(403).json({ message: "Not verified" });
      if (signer.signedAt) return res.status(400).json({ message: "Already signed" });

      const envelope = await storage.getEnvelope(signer.envelopeId);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });

      const existingAnnotations = await storage.getAnnotationsByEnvelopeAndSigner(envelope.id, signer.id);
      const initialedPages = new Set(existingAnnotations.filter(a => a.type === "initial").map(a => a.pageNumber));

      if (initialedPages.size < envelope.totalPages) {
        return res.status(400).json({ message: `Please initial all ${envelope.totalPages} pages before signing.` });
      }

      const txResult = await db.transaction(async (tx) => {
        const claimed = await storage.atomicClaimSign(signer.id, tx);
        if (!claimed) {
          throw new Error("ALREADY_SIGNED");
        }

        await storage.createAnnotation({
          envelopeId: envelope.id,
          signerId: signer.id,
          pageNumber: envelope.totalPages,
          xPos: 0.5,
          yPos: 0.9,
          type: "signature",
          value: signer.fullName,
        }, tx);

        const txSigners = await storage.getSignersByEnvelope(envelope.id, tx);
        const txAllSigned = txSigners.every(s => s.signedAt !== null);

        if (txAllSigned) {
          await storage.updateEnvelope(envelope.id, { status: "signed" }, tx);
        }

        await storage.createAuditEvent({
          envelopeId: envelope.id,
          eventType: "Document signed",
          actorEmail: signer.email,
          ipAddress: req.ip || null,
          metadata: null,
        }, tx);

        return { allSigned: txAllSigned, allSigners: txSigners };
      }).catch((err) => {
        if (err.message === "ALREADY_SIGNED") {
          return null as null;
        }
        throw err;
      });

      if (!txResult) {
        return res.status(400).json({ message: "Already signed" });
      }

      const { allSigned, allSigners } = txResult;

      if (allSigned && envelope.originalPdfUrl) {
        try {
          const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");
          const downloaded = await downloadFile(envelope.originalPdfUrl);
          if (downloaded) {
            const pdfDoc = await PDFDocument.load(downloaded.data);
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

            const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

            for (const s of allSigners) {
              const signerAnnotations = await storage.getAnnotationsByEnvelopeAndSigner(envelope.id, s.id);
              for (const ann of signerAnnotations) {
                const pageIndex = ann.pageNumber - 1;
                if (pageIndex >= 0 && pageIndex < pdfDoc.getPageCount()) {
                  const page = pdfDoc.getPage(pageIndex);
                  const { width, height } = page.getSize();

                  if (ann.type === "signature" && s.signedAt) {
                    const signedAt = new Date(s.signedAt);
                    const dateStr = signedAt.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
                    const authId = createHash("sha256")
                      .update(`${s.id}-${envelope.id}-${s.signedAt}`)
                      .digest("hex").substring(0, 12).toUpperCase();

                    const boxWidth = 220;
                    const boxHeight = 68;
                    const margin = 10;
                    let boxX = ann.xPos * width - boxWidth / 2;
                    let boxY = (1 - ann.yPos) * height - boxHeight / 2;
                    boxX = Math.max(margin, Math.min(boxX, width - boxWidth - margin));
                    boxY = Math.max(margin, Math.min(boxY, height - boxHeight - margin));
                    const padding = 8;
                    const lineHeight = 14;
                    const labelSize = 8;
                    const titleSize = 9;

                    page.drawRectangle({
                      x: boxX,
                      y: boxY,
                      width: boxWidth,
                      height: boxHeight,
                      borderColor: rgb(0.8, 0, 0),
                      borderWidth: 1.5,
                      color: rgb(1, 1, 1),
                      opacity: 0.95,
                    });

                    const textX = boxX + padding;
                    let textY = boxY + boxHeight - padding - titleSize;

                    page.drawText("DIGITAL ENVELOPE", {
                      x: textX,
                      y: textY,
                      size: titleSize,
                      font: fontBold,
                      color: rgb(0, 0, 0.7),
                    });
                    textY -= lineHeight;

                    page.drawText(`SIGNED BY: ${s.fullName}`, {
                      x: textX,
                      y: textY,
                      size: labelSize,
                      font: fontBold,
                      color: rgb(0, 0, 0.7),
                    });
                    textY -= lineHeight;

                    page.drawText(`DATE: ${dateStr}`, {
                      x: textX,
                      y: textY,
                      size: labelSize,
                      font: fontBold,
                      color: rgb(0, 0, 0.7),
                    });
                    textY -= lineHeight;

                    page.drawText(`AUTHENTICATION: ${authId}`, {
                      x: textX,
                      y: textY,
                      size: labelSize,
                      font: fontBold,
                      color: rgb(0, 0, 0.7),
                    });
                  } else {
                    page.drawText(`[${ann.value}]`, {
                      x: ann.xPos * width,
                      y: (1 - ann.yPos) * height,
                      size: 7,
                      font,
                      color: rgb(0.1, 0.1, 0.5),
                    });
                  }
                }
              }
            }

            const signedBytes = await pdfDoc.save();
            const signedFileName = `signed_${Date.now()}.pdf`;
            const signedPdfUrl = await uploadFile(signedFileName, Buffer.from(signedBytes));
            await storage.updateEnvelope(envelope.id, { signedPdfUrl });
          }
        } catch (pdfErr) {
          console.error("PDF signing failed:", pdfErr);
        }
      }

      if (allSigned) {
        const firmEmail = await getGmailProfile();
        const emailCfg = await loadEmailSettings();

        const baseUrl = `${req.protocol}://${req.get("host")}`;

        const updatedEnvelope = await storage.getEnvelope(envelope.id);
        let signedPdfAttachment: { filename: string; content: Buffer; mimeType: string } | null = null;
        if (updatedEnvelope?.signedPdfUrl) {
          try {
            const signedFile = await downloadFile(updatedEnvelope.signedPdfUrl);
            if (signedFile) {
              signedPdfAttachment = {
                filename: `signed_${envelope.subject.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`,
                content: Buffer.from(signedFile.data),
                mimeType: "application/pdf",
              };
            }
          } catch (dlErr) {
            console.error("Failed to download signed PDF for email attachment:", dlErr);
          }
        }

        for (const s of allSigners) {
          try {
            const downloadUrl = `${baseUrl}/api/sign/${s.accessToken}/download`;
            await sendEmail(
              s.email,
              `[${emailCfg.firmName}] Document signed: ${envelope.subject}`,
              wrapEmail(`
                <h2 style="color: #16a34a; margin-top: 0;">Document Successfully Signed</h2>
                <p>Dear ${escapeHtml(s.fullName)},</p>
                <p>${emailCfg.completionBody}</p>
                ${envelope.externalRef ? `<p><strong>Reference:</strong> ${escapeHtml(envelope.externalRef)}</p>` : ""}
                <p>A signed copy of the document is attached to this email. You can also download it using the link below:</p>
                <p style="margin: 16px 0;"><a href="${downloadUrl}" style="display: inline-block; padding: 10px 24px; background-color: #16a34a; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">Download Signed Document</a></p>
              `, baseUrl, emailCfg),
              envelope.gmailThreadId || undefined,
              signedPdfAttachment ? [signedPdfAttachment] : undefined
            );
          } catch (err) {
            console.error(`Failed to send signed notification to ${s.email}:`, err);
          }
        }

        if (firmEmail) {
          try {
            await sendEmail(
              firmEmail,
              `[${emailCfg.firmName}] All signatures complete: ${envelope.subject}`,
              wrapEmail(`
                <h2 style="color: #16a34a; margin-top: 0;">All Signatures Collected</h2>
                <p>${emailCfg.completionBody}</p>
                ${envelope.externalRef ? `<p><strong>Reference:</strong> ${escapeHtml(envelope.externalRef)}</p>` : ""}
                <p>Signers: ${allSigners.map(s => escapeHtml(s.fullName)).join(", ")}</p>
              `, baseUrl, emailCfg),
              envelope.gmailThreadId || undefined
            );
          } catch (err) {
            console.error("Failed to send completion notification:", err);
          }
        }

        if (envelope.webhookUrl) {
          try {
            await sendWebhook(envelope.webhookUrl, {
              event: "envelope.signed",
              envelopeId: envelope.id,
              externalRef: envelope.externalRef,
              status: "signed",
            });
          } catch (err: any) {
            console.error(`Webhook delivery failed for envelope ${envelope.id}:`, err.message);
          }
        }
      }

      res.json({ success: true, allSigned });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/sign/:token/download", async (req, res) => {
    try {
      const signer = await storage.getSignerByToken(req.params.token);
      if (!signer) return res.status(404).json({ message: "Invalid link" });
      if (!signer.otpVerified) return res.status(403).json({ message: "Not verified" });
      if (!signer.signedAt) return res.status(400).json({ message: "Document not yet signed" });

      const envelope = await storage.getEnvelope(signer.envelopeId);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });

      const pdfUrl = envelope.signedPdfUrl || envelope.originalPdfUrl;
      if (!pdfUrl) return res.status(404).json({ message: "No PDF available" });

      const fileName = pdfUrl.replace(/^.*\//, "");
      if (!fileName || fileName.includes("..")) {
        return res.status(403).json({ message: "Access denied" });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="signed_${envelope.subject.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf"`);
      const streamed = await streamFileToResponse(`/uploads/${fileName}`, res);
      if (!streamed && !res.headersSent) {
        return res.status(404).json({ message: "File not found" });
      }
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ message: err.message });
      }
    }
  });

  app.post("/api/v1/envelopes/create", async (req, res) => {
    try {
      const parsed = createApiEnvelopeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid request data", errors: parsed.error.flatten().fieldErrors });
      }
      const { subject, signerEmail, signerName, signers, externalRef, pdfUrl, pdfBase64, webhookUrl } = parsed.data;

      let savedPdfUrl: string | null = pdfUrl || null;
      let totalPages = 1;

      if (pdfBase64) {
        let pdfBuffer: Buffer;
        try {
          pdfBuffer = Buffer.from(pdfBase64, "base64");
          const { PDFDocument } = await import("pdf-lib");
          const pdfDoc = await PDFDocument.load(pdfBuffer);
          totalPages = pdfDoc.getPageCount();
        } catch (e: any) {
          return res.status(400).json({ message: "Invalid PDF data: " + e.message });
        }

        const fileName = `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`;
        savedPdfUrl = await uploadFile(fileName, pdfBuffer);
      }

      const signerList = (signers && signers.length > 0)
        ? signers
        : [{ email: signerEmail!, fullName: signerName || signerEmail! }];

      let envelope;
      try {
        envelope = await db.transaction(async (tx) => {
        const env = await storage.createEnvelope({
          subject,
          externalRef: externalRef || null,
          webhookUrl: webhookUrl || null,
          originalPdfUrl: savedPdfUrl,
          signedPdfUrl: null,
          totalPages,
          status: "draft",
          gmailThreadId: null,
        }, tx);

        for (const s of signerList) {
          await storage.createSigner({
            envelopeId: env.id,
            email: s.email,
            fullName: s.fullName,
            accessToken: generateToken(),
          }, tx);
        }

        await storage.createAuditEvent({
          envelopeId: env.id,
          eventType: "Envelope created via API",
          actorEmail: null,
          ipAddress: req.ip || null,
          metadata: JSON.stringify({ source: "ArchiDoc", signerCount: signerList.length }),
        }, tx);

        return env;
        });
      } catch (txErr) {
        if (savedPdfUrl && pdfBase64) {
          await deleteFile(savedPdfUrl);
        }
        throw txErr;
      }

      const full = await storage.getEnvelope(envelope.id);
      res.json(full);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.use("/uploads", async (req, res, next) => {
    const fileName = req.path.replace(/^\/+/, "");
    if (!fileName || fileName.includes("..") || fileName.includes("/")) {
      return res.status(403).json({ message: "Access denied" });
    }
    try {
      const streamed = await streamFileToResponse(`/uploads/${fileName}`, res);
      if (!streamed) {
        return res.status(404).json({ message: "File not found" });
      }
    } catch {
      if (!res.headersSent) {
        res.status(404).json({ message: "File not found" });
      }
    }
  });

  app.get("/api/settings", async (_req, res) => {
    try {
      const allSettings = await storage.getAllSettings();
      res.json(allSettings);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/settings/:key", async (req, res) => {
    try {
      const setting = await storage.getSetting(req.params.key);
      if (!setting) return res.status(404).json({ error: "Setting not found" });
      res.json(setting);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/envelopes/:id/soft-delete", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const { reason } = req.body || {};
      if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
        return res.status(400).json({ message: "A reason for deletion is required" });
      }
      const envelope = await storage.softDeleteEnvelope(id);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });
      await storage.createAuditEvent({
        envelopeId: id,
        eventType: "Envelope deleted",
        actorEmail: (req.user as any)?.email || null,
        ipAddress: req.ip || null,
        metadata: JSON.stringify({ reason: reason.trim() }),
      });
      res.json(envelope);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/envelopes/:id/restore", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const envelope = await storage.restoreEnvelope(id);
      if (!envelope) return res.status(404).json({ message: "Envelope not found" });
      res.json(envelope);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/rollback-versions", async (_req, res) => {
    try {
      const versions = await storage.getRollbackVersions();
      res.json(versions);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/rollback-versions", async (req, res) => {
    try {
      const parsed = insertRollbackVersionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
      const version = await storage.createRollbackVersion(parsed.data);
      res.json(version);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/rollback-versions/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const allowedFields: Record<string, unknown> = {};
      if (req.body.versionLabel !== undefined) allowedFields.versionLabel = req.body.versionLabel;
      if (req.body.note !== undefined) allowedFields.note = req.body.note;
      if (req.body.status !== undefined) {
        if (!["active", "superseded"].includes(req.body.status)) {
          return res.status(400).json({ message: "Invalid status. Must be 'active' or 'superseded'" });
        }
        allowedFields.status = req.body.status;
      }
      const updated = await storage.updateRollbackVersion(id, allowedFields);
      if (!updated) return res.status(404).json({ message: "Version not found" });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/rollback-versions/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      await storage.deleteRollbackVersion(id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/backups", async (_req, res) => {
    try {
      const allBackups = await storage.getBackups();
      res.json(allBackups);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/backups", async (_req, res) => {
    try {
      const allEnvelopes = await storage.getEnvelopes();
      const allSettings = await storage.getAllSettings();
      const versions = await storage.getRollbackVersions();

      const backupData = {
        exportedAt: new Date().toISOString(),
        envelopes: allEnvelopes,
        settings: allSettings,
        rollbackVersions: versions,
      };

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `archisign-backup-manual-${timestamp}.json`;
      await uploadBackup(filename, JSON.stringify(backupData, null, 2));

      const backup = await storage.createBackup({ filename });
      res.json(backup);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/backups/:id/download", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const allBackups = await storage.getBackups();
      const backup = allBackups.find(b => b.id === id);
      if (!backup) return res.status(404).json({ message: "Backup not found" });
      const backupData = await downloadBackup(backup.filename);
      if (!backupData) {
        return res.status(404).json({ message: "Backup file not found" });
      }
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${backup.filename}"`);
      res.send(backupData);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/backups/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const allBackups = await storage.getBackups();
      const backup = allBackups.find(b => b.id === id);
      if (backup) {
        await deleteBackupFile(backup.filename);
      }
      await storage.deleteBackup(id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.put("/api/settings", async (req, res) => {
    try {
      const settingsArray = req.body;
      if (!Array.isArray(settingsArray)) {
        return res.status(400).json({ error: "Expected array of settings" });
      }
      const results = [];
      for (const s of settingsArray) {
        if (!s.key || !s.value || !s.label) {
          continue;
        }
        const result = await storage.upsertSetting(s);
        results.push(result);
      }
      res.json(results);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return httpServer;
}

async function sendWebhook(url: string, payload: any): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
  }
}
