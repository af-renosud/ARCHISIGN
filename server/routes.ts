import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { sendEmail, getGmailProfile } from "./gmail";
import { randomBytes } from "crypto";
import multer from "multer";
import path from "path";
import fs from "fs";

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
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads", { recursive: true });
  }

  app.get("/api/envelopes", async (_req, res) => {
    try {
      const envs = await storage.getEnvelopes();
      res.json(envs);
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
      const { subject, externalRef, webhookUrl, message } = req.body;
      if (!subject) return res.status(400).json({ message: "Subject is required" });

      let signersData;
      try {
        signersData = JSON.parse(req.body.signers || "[]");
      } catch {
        return res.status(400).json({ message: "Invalid signers data" });
      }

      if (!signersData.length) return res.status(400).json({ message: "At least one signer is required" });

      let pdfUrl: string | undefined;
      let totalPages = 1;
      if (req.file) {
        const ext = path.extname(req.file.originalname);
        const newName = `${req.file.filename}${ext}`;
        const newPath = path.join("uploads", newName);
        fs.renameSync(req.file.path, newPath);
        pdfUrl = `/uploads/${newName}`;

        try {
          const { PDFDocument } = await import("pdf-lib");
          const pdfBytes = fs.readFileSync(newPath);
          const pdfDoc = await PDFDocument.load(pdfBytes);
          totalPages = pdfDoc.getPageCount();
        } catch {
          totalPages = 1;
        }
      }

      const envelope = await storage.createEnvelope({
        subject,
        externalRef: externalRef || null,
        message: message || null,
        webhookUrl: webhookUrl || null,
        originalPdfUrl: pdfUrl || null,
        signedPdfUrl: null,
        totalPages,
        status: "draft",
        gmailThreadId: null,
      });

      for (const s of signersData) {
        await storage.createSigner({
          envelopeId: envelope.id,
          email: s.email,
          fullName: s.fullName,
          accessToken: generateToken(),
        });
      }

      await storage.createAuditEvent({
        envelopeId: envelope.id,
        eventType: "Envelope created",
        actorEmail: null,
        ipAddress: req.ip || null,
        metadata: null,
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

      for (const signer of envelope.signers) {
        const signingUrl = `${req.protocol}://${req.get("host")}/sign/${signer.accessToken}`;
        const htmlBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1e40af;">Document Ready for Signing</h2>
            <p>Dear ${signer.fullName},</p>
            <p>You have been invited to review and sign the following document:</p>
            <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 4px 0;"><strong>Subject:</strong> ${envelope.subject}</p>
              ${envelope.externalRef ? `<p style="margin: 4px 0;"><strong>Reference:</strong> ${envelope.externalRef}</p>` : ""}
              ${envelope.message ? `<p style="margin: 12px 0 4px 0; white-space: pre-line;">${envelope.message}</p>` : ""}
            </div>
            <p>Please click the button below to verify your identity and review the document:</p>
            <a href="${signingUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Review & Sign Document</a>
            <p style="margin-top: 24px; color: #64748b; font-size: 12px;">This is a secure link. Do not share it with anyone. Powered by ArchiSign Pro.</p>
          </div>
        `;

        try {
          const result = await sendEmail(
            signer.email,
            `[ArchiSign] Please sign: ${envelope.subject}`,
            htmlBody
          );

          if (result.threadId && !envelope.gmailThreadId) {
            await storage.updateEnvelope(id, { gmailThreadId: result.threadId });
          }
        } catch (err) {
          console.error(`Failed to send email to ${signer.email}:`, err);
        }
      }

      await storage.updateEnvelope(id, { status: "sent" });
      await storage.createAuditEvent({
        envelopeId: id,
        eventType: "Envelope sent for signing",
        actorEmail: firmEmail || null,
        ipAddress: req.ip || null,
        metadata: null,
      });

      if (envelope.webhookUrl) {
        sendWebhook(envelope.webhookUrl, {
          event: "envelope.sent",
          envelopeId: id,
          externalRef: envelope.externalRef,
          status: "sent",
        });
      }

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

      for (const signer of envelope.signers) {
        const htmlBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h3 style="color: #1e40af;">Response from Architect</h3>
            <p>Dear ${signer.fullName},</p>
            <p>Regarding: <strong>${envelope.subject}</strong></p>
            <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0; white-space: pre-wrap;">${message}</div>
            <p>You may continue to <a href="${req.protocol}://${req.get("host")}/sign/${signer.accessToken}">review and sign the document</a>.</p>
            <p style="color: #64748b; font-size: 12px;">Powered by ArchiSign Pro.</p>
          </div>
        `;

        try {
          await sendEmail(
            signer.email,
            `Re: [ArchiSign] ${envelope.subject}`,
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
        otpCode: otp,
        otpExpiresAt: expiresAt,
      });

      const envelope = await storage.getEnvelope(signer.envelopeId);

      try {
        await sendEmail(
          signer.email,
          `[ArchiSign] Your verification code: ${otp}`,
          `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1e40af;">Verification Code</h2>
            <p>Dear ${signer.fullName},</p>
            <p>Your verification code for signing "${envelope?.subject}" is:</p>
            <div style="background: #f8fafc; border-radius: 8px; padding: 24px; margin: 16px 0; text-align: center;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1e40af;">${otp}</span>
            </div>
            <p>This code expires in 10 minutes.</p>
            <p style="color: #64748b; font-size: 12px;">If you did not request this code, please ignore this email. Powered by ArchiSign Pro.</p>
          </div>
          `
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

      if (signer.otpCode !== code) {
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

      if (firmEmail) {
        try {
          await sendEmail(
            firmEmail,
            `[ArchiSign Query] ${envelope.subject} - from ${signer.fullName}`,
            `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #dc2626;">Clarification Request</h2>
              <div style="background: #fef2f2; border-radius: 8px; padding: 16px; margin: 16px 0;">
                <p style="margin: 4px 0;"><strong>Document:</strong> ${envelope.subject}</p>
                <p style="margin: 4px 0;"><strong>From:</strong> ${signer.fullName} (${signer.email})</p>
                ${envelope.externalRef ? `<p style="margin: 4px 0;"><strong>Reference:</strong> ${envelope.externalRef}</p>` : ""}
              </div>
              <h3>Query:</h3>
              <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0; white-space: pre-wrap;">${message}</div>
              <p style="color: #64748b; font-size: 12px;">Reply to this email or respond through the ArchiSign Pro admin panel.</p>
            </div>
            `,
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
        sendWebhook(envelope.webhookUrl, {
          event: "envelope.queried",
          envelopeId: envelope.id,
          externalRef: envelope.externalRef,
          status: "queried",
          queryFrom: signer.email,
          queryMessage: message,
        });
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

      await storage.createAnnotation({
        envelopeId: envelope.id,
        signerId: signer.id,
        pageNumber: envelope.totalPages,
        xPos: 0.5,
        yPos: 0.9,
        type: "signature",
        value: signer.fullName,
      });

      await storage.updateSigner(signer.id, { signedAt: new Date() });

      const allSigners = await storage.getSignersByEnvelope(envelope.id);
      const allSigned = allSigners.every(s => s.id === signer.id || s.signedAt);

      if (allSigned) {
        let signedPdfUrl: string | null = null;
        if (envelope.originalPdfUrl) {
          try {
            const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");
            const pdfPath = path.join(process.cwd(), envelope.originalPdfUrl.replace(/^\//, ""));
            if (fs.existsSync(pdfPath)) {
              const pdfBytes = fs.readFileSync(pdfPath);
              const pdfDoc = await PDFDocument.load(pdfBytes);
              const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

              for (const s of allSigners) {
                const signerAnnotations = await storage.getAnnotationsByEnvelopeAndSigner(envelope.id, s.id);
                for (const ann of signerAnnotations) {
                  const pageIndex = ann.pageNumber - 1;
                  if (pageIndex >= 0 && pageIndex < pdfDoc.getPageCount()) {
                    const page = pdfDoc.getPage(pageIndex);
                    const { width, height } = page.getSize();
                    const text = ann.type === "signature" ? `Signed: ${ann.value}` : `[${ann.value}]`;
                    const fontSize = ann.type === "signature" ? 10 : 7;
                    page.drawText(text, {
                      x: ann.xPos * width,
                      y: (1 - ann.yPos) * height,
                      size: fontSize,
                      font,
                      color: rgb(0.1, 0.1, 0.5),
                    });
                  }
                }
              }

              const signedBytes = await pdfDoc.save();
              const signedFileName = `signed_${Date.now()}.pdf`;
              const signedPath = path.join("uploads", signedFileName);
              fs.writeFileSync(signedPath, signedBytes);
              signedPdfUrl = `/uploads/${signedFileName}`;
            }
          } catch (pdfErr) {
            console.error("PDF signing failed:", pdfErr);
          }
        }

        await storage.updateEnvelope(envelope.id, { status: "signed", signedPdfUrl });

        const firmEmail = await getGmailProfile();

        for (const s of allSigners) {
          try {
            await sendEmail(
              s.email,
              `[ArchiSign] Document signed: ${envelope.subject}`,
              `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #16a34a;">Document Successfully Signed</h2>
                <p>Dear ${s.fullName},</p>
                <p>The document "<strong>${envelope.subject}</strong>" has been signed by all parties.</p>
                ${envelope.externalRef ? `<p><strong>Reference:</strong> ${envelope.externalRef}</p>` : ""}
                <p style="color: #64748b; font-size: 12px;">A finalized copy will be available shortly. Powered by ArchiSign Pro.</p>
              </div>
              `,
              envelope.gmailThreadId || undefined
            );
          } catch (err) {
            console.error(`Failed to send signed notification to ${s.email}:`, err);
          }
        }

        if (firmEmail) {
          try {
            await sendEmail(
              firmEmail,
              `[ArchiSign] All signatures complete: ${envelope.subject}`,
              `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #16a34a;">All Signatures Collected</h2>
                <p>All parties have signed "<strong>${envelope.subject}</strong>".</p>
                ${envelope.externalRef ? `<p><strong>Reference:</strong> ${envelope.externalRef}</p>` : ""}
                <p>Signers: ${allSigners.map(s => s.fullName).join(", ")}</p>
              </div>
              `,
              envelope.gmailThreadId || undefined
            );
          } catch (err) {
            console.error("Failed to send completion notification:", err);
          }
        }

        if (envelope.webhookUrl) {
          sendWebhook(envelope.webhookUrl, {
            event: "envelope.signed",
            envelopeId: envelope.id,
            externalRef: envelope.externalRef,
            status: "signed",
          });
        }
      }

      await storage.createAuditEvent({
        envelopeId: envelope.id,
        eventType: "Document signed",
        actorEmail: signer.email,
        ipAddress: req.ip || null,
        metadata: null,
      });

      res.json({ success: true, allSigned });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/v1/envelopes/create", async (req, res) => {
    try {
      const { subject, signerEmail, signerName, externalRef, pdfUrl, webhookUrl } = req.body;

      if (!subject || !signerEmail) {
        return res.status(400).json({ message: "subject and signerEmail are required" });
      }

      const envelope = await storage.createEnvelope({
        subject,
        externalRef: externalRef || null,
        webhookUrl: webhookUrl || null,
        originalPdfUrl: pdfUrl || null,
        signedPdfUrl: null,
        totalPages: 1,
        status: "draft",
        gmailThreadId: null,
      });

      await storage.createSigner({
        envelopeId: envelope.id,
        email: signerEmail,
        fullName: signerName || signerEmail,
        accessToken: generateToken(),
      });

      await storage.createAuditEvent({
        envelopeId: envelope.id,
        eventType: "Envelope created via API",
        actorEmail: null,
        ipAddress: req.ip || null,
        metadata: JSON.stringify({ source: "ArchiDoc" }),
      });

      const full = await storage.getEnvelope(envelope.id);
      res.json(full);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.use("/uploads", (req, res, next) => {
    const filePath = path.join(process.cwd(), "uploads", req.path);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ message: "File not found" });
    }
  });

  return httpServer;
}

function sendWebhook(url: string, payload: any) {
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error("Webhook delivery failed:", err.message);
  });
}
