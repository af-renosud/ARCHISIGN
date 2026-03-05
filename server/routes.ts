import type { Express, RequestHandler } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { db } from "./db";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import { insertRollbackVersionSchema, insertBackupSchema, createEnvelopeRequestSchema, createSignerRequestSchema, createApiEnvelopeRequestSchema } from "@shared/schema";
import { z } from "zod";
import multer from "multer";
import path from "path";
import fs from "fs";
import fsPromises from "fs/promises";
import { uploadFile, downloadFile, streamFileToResponse, fileExists, deleteFile, uploadBackup, downloadBackup, deleteBackupFile } from "./fileStorage";
import { getPageCount, stampSignedPdf } from "./services/PdfService";
import { generateToken, generateOtp, hashOtp, verifyOtp, buildSigningLink, generateAuthenticationId } from "./services/SecurityService";
import { dispatchWebhook, sendSigningInvitation, sendResendInvitation, sendReplyNotification, sendOtpEmail, sendQueryNotification, sendCompletionNotifications, loadEmailSettings, getGmailProfile } from "./services/NotificationService";
import { asyncHandler } from "./middleware/asyncHandler";
import { validateId } from "./middleware/validators";

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

  app.get("/api/envelopes", asyncHandler(async (_req, res) => {
    const envs = await storage.getEnvelopes();
    res.json(envs);
  }));

  app.get("/api/envelopes/deleted", asyncHandler(async (_req, res) => {
    const deleted = await storage.getDeletedEnvelopes();
    res.json(deleted);
  }));

  app.get("/api/envelopes/:id", validateId, asyncHandler(async (req, res) => {
    const id = (req as any).validatedId;
    const envelope = await storage.getEnvelope(id);
    if (!envelope) return res.status(404).json({ message: "Envelope not found" });
    res.json(envelope);
  }));

  app.post("/api/envelopes", upload.single("pdf"), asyncHandler(async (req, res) => {
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
          totalPages = await getPageCount(pdfBytes);
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
  }));

  app.get("/api/envelopes/:id/annotations", validateId, asyncHandler(async (req, res) => {
    const id = (req as any).validatedId;
    const envelope = await storage.getEnvelope(id);
    if (!envelope) return res.status(404).json({ message: "Envelope not found" });
    const allAnnotations = await storage.getAnnotationsByEnvelope(id);
    res.json(allAnnotations);
  }));

  const annotationCreateSchema = z.object({
    signerId: z.number().int().positive(),
    pageNumber: z.number().int().positive(),
    xPos: z.number().min(0).max(1),
    yPos: z.number().min(0).max(1),
    width: z.number().min(0.01).max(1).optional(),
    height: z.number().min(0.01).max(1).optional(),
    type: z.enum(["initial", "signature", "date"]),
  });
  const annotationUpdateSchema = z.object({
    xPos: z.number().min(0).max(1).optional(),
    yPos: z.number().min(0).max(1).optional(),
    width: z.number().min(0.01).max(1).optional().nullable(),
    height: z.number().min(0.01).max(1).optional().nullable(),
    pageNumber: z.number().int().positive().optional(),
  });

  app.post("/api/envelopes/:id/annotations", validateId, asyncHandler(async (req, res) => {
    const id = (req as any).validatedId;
    const envelope = await storage.getEnvelope(id);
    if (!envelope) return res.status(404).json({ message: "Envelope not found" });
    if (envelope.status !== "draft") return res.status(400).json({ message: "Can only place fields on draft envelopes" });
    const parsed = annotationCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid annotation data", errors: parsed.error.flatten().fieldErrors });
    const { signerId, pageNumber, xPos, yPos, width, height, type } = parsed.data;
    if (!envelope.signers.some(s => s.id === signerId)) return res.status(400).json({ message: "Signer does not belong to this envelope" });
    if (pageNumber > envelope.totalPages) return res.status(400).json({ message: "Page number exceeds document pages" });
    const annotation = await storage.createAnnotation({
      envelopeId: id, signerId, pageNumber, xPos, yPos,
      width: width ?? null, height: height ?? null, type, value: null, placed: true,
    });
    res.json(annotation);
  }));

  app.put("/api/envelopes/:id/annotations/:annotationId", validateId, asyncHandler(async (req, res) => {
    const envelopeId = (req as any).validatedId;
    const annotationId = parseInt(req.params.annotationId);
    if (isNaN(annotationId)) return res.status(400).json({ message: "Invalid annotation ID" });
    const envelope = await storage.getEnvelope(envelopeId);
    if (!envelope) return res.status(404).json({ message: "Envelope not found" });
    if (envelope.status !== "draft") return res.status(400).json({ message: "Can only edit fields on draft envelopes" });
    const parsed = annotationUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid update data", errors: parsed.error.flatten().fieldErrors });
    const updated = await storage.updateAnnotation(annotationId, parsed.data);
    if (!updated) return res.status(404).json({ message: "Annotation not found" });
    res.json(updated);
  }));

  app.delete("/api/envelopes/:id/annotations/:annotationId", validateId, asyncHandler(async (req, res) => {
    const envelopeId = (req as any).validatedId;
    const annotationId = parseInt(req.params.annotationId);
    if (isNaN(annotationId)) return res.status(400).json({ message: "Invalid annotation ID" });
    const envelope = await storage.getEnvelope(envelopeId);
    if (!envelope) return res.status(404).json({ message: "Envelope not found" });
    if (envelope.status !== "draft") return res.status(400).json({ message: "Can only remove fields on draft envelopes" });
    await storage.deleteAnnotation(annotationId);
    res.json({ success: true });
  }));

  app.post("/api/envelopes/:id/send", asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    const envelope = await storage.getEnvelope(id);
    if (!envelope) return res.status(404).json({ message: "Envelope not found" });
    if (envelope.status !== "draft") return res.status(400).json({ message: "Envelope already sent" });

    const firmEmail = await getGmailProfile();
    const emailCfg = await loadEmailSettings();
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const emailResults: { email: string; success: boolean; error?: string }[] = [];

    for (const signer of envelope.signers) {
      try {
        const result = await sendSigningInvitation(signer, envelope, baseUrl, emailCfg);
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

    if (envelope.webhookUrl) {
      await dispatchWebhook(envelope.webhookUrl, {
        event: "envelope.sent",
        envelopeId: id,
        externalRef: envelope.externalRef,
        status: "sent",
      });
    }

    const updated = await storage.getEnvelope(id);
    res.json(updated);
  }));

  app.post("/api/envelopes/:id/resend", asyncHandler(async (req, res) => {
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
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const emailResults: { email: string; success: boolean; error?: string }[] = [];

    for (const signer of pendingSigners) {
      try {
        await sendResendInvitation(signer, envelope, baseUrl, emailCfg);
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
  }));

  app.post("/api/envelopes/:id/reply", asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    const { message } = req.body;
    if (!message) return res.status(400).json({ message: "Message is required" });

    const envelope = await storage.getEnvelope(id);
    if (!envelope) return res.status(404).json({ message: "Envelope not found" });

    const firmEmail = await getGmailProfile();

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const emailCfg = await loadEmailSettings();
    for (const signer of envelope.signers) {
      try {
        await sendReplyNotification(signer, envelope, message, baseUrl, emailCfg);
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
  }));

  app.get("/api/sign/:token/info", asyncHandler(async (req, res) => {
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
  }));

  app.post("/api/sign/:token/request-otp", asyncHandler(async (req, res) => {
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
      await sendOtpEmail(signer, envelope?.subject || "", otp, baseUrl, emailCfg);
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
  }));

  app.post("/api/sign/:token/verify-otp", asyncHandler(async (req, res) => {
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

    if (!verifyOtp(String(code), signer.otpCode)) {
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
  }));

  app.get("/api/sign/:token/document", asyncHandler(async (req, res) => {
    const signer = await storage.getSignerByToken(req.params.token);
    if (!signer) return res.status(404).json({ message: "Invalid link" });
    if (!signer.otpVerified) return res.status(403).json({ message: "Not verified" });

    const envelope = await storage.getEnvelope(signer.envelopeId);
    if (!envelope) return res.status(404).json({ message: "Envelope not found" });

    const existingAnnotations = await storage.getAnnotationsByEnvelopeAndSigner(envelope.id, signer.id);
    const initialedPages = existingAnnotations
      .filter(a => a.type === "initial" && a.value !== null)
      .map(a => a.pageNumber);

    const placedFields = existingAnnotations
      .filter(a => a.placed)
      .map(a => ({
        id: a.id,
        type: a.type,
        pageNumber: a.pageNumber,
        xPos: a.xPos,
        yPos: a.yPos,
        width: a.width,
        height: a.height,
      }));

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
          ? generateAuthenticationId(signer.id, envelope.id, signer.signedAt)
          : null,
      },
      totalPages: envelope.totalPages,
      initialed: [...new Set(initialedPages)],
      placedFields,
    });
  }));

  app.post("/api/sign/:token/initial", asyncHandler(async (req, res) => {
    const signer = await storage.getSignerByToken(req.params.token);
    if (!signer) return res.status(404).json({ message: "Invalid link" });
    if (!signer.otpVerified) return res.status(403).json({ message: "Not verified" });
    if (signer.signedAt) return res.status(400).json({ message: "Already signed" });

    const { pageNumber } = req.body;
    if (!pageNumber || typeof pageNumber !== "number") {
      return res.status(400).json({ message: "Page number is required" });
    }

    const allAnnotations = await storage.getAnnotationsByEnvelope(signer.envelopeId);
    const placedInitial = allAnnotations.find(
      a => a.placed && a.type === "initial" && a.pageNumber === pageNumber && a.signerId === signer.id
    );

    const initials = signer.fullName.split(" ").map(n => n[0]).join("").toUpperCase();

    if (placedInitial) {
      await storage.updateAnnotation(placedInitial.id, { value: initials });
    } else {
      await storage.createAnnotation({
        envelopeId: signer.envelopeId,
        signerId: signer.id,
        pageNumber,
        xPos: 0.9,
        yPos: 0.95,
        type: "initial",
        value: initials,
      });
    }

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
  }));

  app.post("/api/sign/:token/query", asyncHandler(async (req, res) => {
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
        await sendQueryNotification(signer, envelope, message, firmEmail, baseUrl, emailCfg);
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
      await dispatchWebhook(envelope.webhookUrl, {
        event: "envelope.queried",
        envelopeId: envelope.id,
        externalRef: envelope.externalRef,
        status: "queried",
        queryFrom: signer.email,
        queryMessage: message,
      });
    }

    res.json({ success: true });
  }));

  app.post("/api/sign/:token/sign", asyncHandler(async (req, res) => {
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

    const allEnvelopeAnnotations = await storage.getAnnotationsByEnvelope(envelope.id);
    const placedSignature = allEnvelopeAnnotations.find(
      a => a.placed && a.type === "signature" && a.signerId === signer.id
    );
    const placedDateFields = allEnvelopeAnnotations.filter(
      a => a.placed && a.type === "date" && a.signerId === signer.id
    );

    const txResult = await db.transaction(async (tx) => {
      const claimed = await storage.atomicClaimSign(signer.id, tx);
      if (!claimed) {
        throw new Error("ALREADY_SIGNED");
      }

      const signDateStr = new Date().toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });

      for (const dateField of placedDateFields) {
        await storage.updateAnnotation(dateField.id, { value: signDateStr });
      }

      if (placedSignature) {
        await storage.updateAnnotation(placedSignature.id, { value: signer.fullName });
      } else {
        await storage.createAnnotation({
          envelopeId: envelope.id,
          signerId: signer.id,
          pageNumber: envelope.totalPages,
          xPos: 0.5,
          yPos: 0.9,
          type: "signature",
          value: signer.fullName,
        }, tx);
      }

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
        const downloaded = await downloadFile(envelope.originalPdfUrl);
        if (downloaded) {
          const signersWithAnnotations = await Promise.all(
            allSigners.map(async (s) => ({
              signer: { id: s.id, fullName: s.fullName, signedAt: s.signedAt },
              annotations: await storage.getAnnotationsByEnvelopeAndSigner(envelope.id, s.id),
            }))
          );

          const { signedPdfBytes } = await stampSignedPdf(
            Buffer.from(downloaded.data),
            signersWithAnnotations,
            envelope.id,
          );

          const signedFileName = `signed_${Date.now()}.pdf`;
          const signedPdfUrl = await uploadFile(signedFileName, Buffer.from(signedPdfBytes));
          await storage.updateEnvelope(envelope.id, { signedPdfUrl });
        }
      } catch (pdfErr) {
        console.error("PDF signing failed:", pdfErr);
      }
    }

    if (allSigned) {
      const emailCfg = await loadEmailSettings();
      const baseUrl = `${req.protocol}://${req.get("host")}`;

      const updatedEnvelope = await storage.getEnvelope(envelope.id);
      await sendCompletionNotifications(
        { ...envelope, signedPdfUrl: updatedEnvelope?.signedPdfUrl || null },
        allSigners,
        baseUrl,
        emailCfg,
      );

      if (envelope.webhookUrl) {
        await dispatchWebhook(envelope.webhookUrl, {
          event: "envelope.signed",
          envelopeId: envelope.id,
          externalRef: envelope.externalRef,
          status: "signed",
        });
      }
    }

    res.json({ success: true, allSigned });
  }));

  app.get("/api/sign/:token/download", asyncHandler(async (req, res) => {
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
  }));

  app.post("/api/v1/envelopes/create", asyncHandler(async (req, res) => {
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
        totalPages = await getPageCount(pdfBuffer);
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
  }));

  app.use("/uploads", asyncHandler(async (req, res) => {
    const fileName = req.path.replace(/^\/+/, "");
    if (!fileName || fileName.includes("..") || fileName.includes("/")) {
      return res.status(403).json({ message: "Access denied" });
    }
    const streamed = await streamFileToResponse(`/uploads/${fileName}`, res);
    if (!streamed) {
      return res.status(404).json({ message: "File not found" });
    }
  }));

  app.get("/api/settings", asyncHandler(async (_req, res) => {
    res.json(await storage.getAllSettings());
  }));
  app.get("/api/settings/:key", asyncHandler(async (req, res) => {
    const setting = await storage.getSetting(req.params.key);
    if (!setting) return res.status(404).json({ error: "Setting not found" });
    res.json(setting);
  }));
  app.put("/api/settings", asyncHandler(async (req, res) => {
    if (!Array.isArray(req.body)) return res.status(400).json({ error: "Expected array of settings" });
    const results = [];
    for (const s of req.body) {
      if (!s.key || !s.value || !s.label) continue;
      results.push(await storage.upsertSetting(s));
    }
    res.json(results);
  }));

  app.post("/api/envelopes/:id/soft-delete", validateId, asyncHandler(async (req, res) => {
    const id = (req as any).validatedId;
    const { reason } = req.body || {};
    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      return res.status(400).json({ message: "A reason for deletion is required" });
    }
    const envelope = await storage.softDeleteEnvelope(id);
    if (!envelope) return res.status(404).json({ message: "Envelope not found" });
    await storage.createAuditEvent({
      envelopeId: id, eventType: "Envelope deleted",
      actorEmail: (req.user as any)?.email || null,
      ipAddress: req.ip || null,
      metadata: JSON.stringify({ reason: reason.trim() }),
    });
    res.json(envelope);
  }));
  app.post("/api/envelopes/:id/restore", validateId, asyncHandler(async (req, res) => {
    const id = (req as any).validatedId;
    const envelope = await storage.restoreEnvelope(id);
    if (!envelope) return res.status(404).json({ message: "Envelope not found" });
    res.json(envelope);
  }));

  app.get("/api/rollback-versions", asyncHandler(async (_req, res) => {
    res.json(await storage.getRollbackVersions());
  }));
  app.post("/api/rollback-versions", asyncHandler(async (req, res) => {
    const parsed = insertRollbackVersionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
    res.json(await storage.createRollbackVersion(parsed.data));
  }));
  app.patch("/api/rollback-versions/:id", validateId, asyncHandler(async (req, res) => {
    const id = (req as any).validatedId;
    const allowedFields: Record<string, unknown> = {};
    if (req.body.versionLabel !== undefined) allowedFields.versionLabel = req.body.versionLabel;
    if (req.body.note !== undefined) allowedFields.note = req.body.note;
    if (req.body.status !== undefined) {
      if (!["active", "superseded"].includes(req.body.status)) return res.status(400).json({ message: "Invalid status" });
      allowedFields.status = req.body.status;
    }
    const updated = await storage.updateRollbackVersion(id, allowedFields);
    if (!updated) return res.status(404).json({ message: "Version not found" });
    res.json(updated);
  }));
  app.delete("/api/rollback-versions/:id", validateId, asyncHandler(async (req, res) => {
    await storage.deleteRollbackVersion((req as any).validatedId);
    res.json({ success: true });
  }));

  app.get("/api/backups", asyncHandler(async (_req, res) => {
    res.json(await storage.getBackups());
  }));
  app.post("/api/backups", asyncHandler(async (_req, res) => {
    const backupData = {
      exportedAt: new Date().toISOString(),
      envelopes: await storage.getEnvelopes(),
      settings: await storage.getAllSettings(),
      rollbackVersions: await storage.getRollbackVersions(),
    };
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `archisign-backup-manual-${timestamp}.json`;
    await uploadBackup(filename, JSON.stringify(backupData, null, 2));
    res.json(await storage.createBackup({ filename }));
  }));
  app.get("/api/backups/:id/download", validateId, asyncHandler(async (req, res) => {
    const id = (req as any).validatedId;
    const backup = (await storage.getBackups()).find(b => b.id === id);
    if (!backup) return res.status(404).json({ message: "Backup not found" });
    const backupData = await downloadBackup(backup.filename);
    if (!backupData) return res.status(404).json({ message: "Backup file not found" });
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${backup.filename}"`);
    res.send(backupData);
  }));
  app.delete("/api/backups/:id", validateId, asyncHandler(async (req, res) => {
    const id = (req as any).validatedId;
    const backup = (await storage.getBackups()).find(b => b.id === id);
    if (backup) await deleteBackupFile(backup.filename);
    await storage.deleteBackup(id);
    res.json({ success: true });
  }));

  return httpServer;
}
