import { storage } from "./storage";
import { db } from "./db";
import { envelopes, settings } from "@shared/schema";
import { randomBytes } from "crypto";
import { sql } from "drizzle-orm";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

async function generateSamplePdf(title: string, pages: number, filename: string): Promise<string> {
  const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (let i = 1; i <= pages; i++) {
    const page = pdfDoc.addPage([595, 842]);
    const { width, height } = page.getSize();

    page.drawRectangle({ x: 40, y: height - 80, width: width - 80, height: 50, color: rgb(0.1, 0.15, 0.35) });
    page.drawText("ARCHISIGN", { x: 50, y: height - 60, size: 14, font: fontBold, color: rgb(1, 1, 1) });
    page.drawText(`Page ${i} of ${pages}`, { x: width - 140, y: height - 60, size: 10, font, color: rgb(0.8, 0.8, 0.9) });

    page.drawText(title, { x: 50, y: height - 120, size: 16, font: fontBold, color: rgb(0.1, 0.1, 0.3) });

    page.drawLine({ start: { x: 50, y: height - 135 }, end: { x: width - 50, y: height - 135 }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });

    const sections = [
      { heading: "Project Overview", body: "This document contains the architectural specifications and plans for the referenced project. All dimensions are in millimeters unless otherwise noted." },
      { heading: "Technical Specifications", body: `Section ${i}: Detailed drawings and measurements are provided below. Please review all annotations and confirm compliance with local building codes and regulations.` },
      { heading: "Materials & Standards", body: "All materials must conform to NF EN standards. Concrete class C25/30 minimum. Steel reinforcement HA Fe E500. Refer to DTU 13.1 for foundation requirements." },
      { heading: "Notes", body: "This page requires your initials to confirm review. By initialing, you acknowledge that you have reviewed the content and specifications presented on this page." },
    ];

    let yPos = height - 170;
    for (const section of sections) {
      if (yPos < 100) break;
      page.drawText(section.heading, { x: 50, y: yPos, size: 12, font: fontBold, color: rgb(0.15, 0.25, 0.55) });
      yPos -= 20;

      const words = section.body.split(" ");
      let line = "";
      for (const word of words) {
        const testLine = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(testLine, 10) > width - 110) {
          page.drawText(line, { x: 50, y: yPos, size: 10, font, color: rgb(0.25, 0.25, 0.25) });
          yPos -= 15;
          line = word;
        } else {
          line = testLine;
        }
      }
      if (line) {
        page.drawText(line, { x: 50, y: yPos, size: 10, font, color: rgb(0.25, 0.25, 0.25) });
        yPos -= 25;
      }
    }

    page.drawRectangle({ x: width - 180, y: 40, width: 140, height: 50, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1, color: rgb(0.97, 0.97, 0.97) });
    page.drawText("Initials:", { x: width - 170, y: 70, size: 8, font, color: rgb(0.5, 0.5, 0.5) });

    page.drawText(`Document: ${title}`, { x: 50, y: 50, size: 8, font, color: rgb(0.6, 0.6, 0.6) });
    page.drawText("Confidential - Do not distribute", { x: 50, y: 38, size: 7, font, color: rgb(0.7, 0.7, 0.7) });
  }

  const pdfBytes = await pdfDoc.save();
  const filePath = path.join("uploads", filename);
  await fsPromises.writeFile(filePath, pdfBytes);
  return `/uploads/${filename}`;
}

async function seedSettings() {
  const existingSettings = await db.select({ count: sql<number>`count(*)` }).from(settings);
  if (existingSettings[0].count > 0) return;

  const defaultSettings = [
    { key: "firm_name", value: "Archisign", label: "Firm Name", category: "email" },
    { key: "email_registration_line", value: "INSCRIPTION \u00C0 L\u2019ORDRE DES ARCHITECTES OCCITANIE S24348", label: "Architect Registration Line", category: "email" },
    { key: "email_footer_text", value: "Powered by Archisign", label: "Email Footer Text", category: "email" },
    { key: "email_invitation_subject_prefix", value: "Signature Required:", label: "Invitation Email Subject Prefix", category: "email" },
    { key: "email_invitation_body", value: "You have been invited to review and sign a document. Please click the button below to access the secure signing portal.", label: "Invitation Email Body", category: "email" },
    { key: "email_otp_body", value: "Please use the verification code below to access the document. This code expires in 10 minutes.", label: "OTP Email Body Text", category: "email" },
    { key: "email_completion_body", value: "All parties have completed signing the document. The signed document is now available for download.", label: "Completion Notification Body", category: "email" },
  ];

  for (const s of defaultSettings) {
    await storage.upsertSetting(s);
  }
}

export async function seedDatabase() {
  await seedSettings();

  const existing = await db.select({ count: sql<number>`count(*)` }).from(envelopes);
  if (existing[0].count > 0) return;

  console.log("Seeding database with sample data...");

  await fsPromises.mkdir("uploads", { recursive: true });

  const pdf1Url = await generateSamplePdf("Villa Montpellier - Phase 2 Structural Plans", 5, "sample_structural_plans.pdf");
  const pdf2Url = await generateSamplePdf("Residence Les Oliviers - Contract Amendment", 3, "sample_contract_amendment.pdf");
  const pdf3Url = await generateSamplePdf("Centre Commercial Etoile - Electrical Plans", 8, "sample_electrical_plans.pdf");
  const pdf4Url = await generateSamplePdf("Maison Vaucluse - Landscape Design Approval", 2, "sample_landscape_design.pdf");
  const pdf5Url = await generateSamplePdf("Bureau Haussmann - Interior Renovation Plans", 4, "sample_interior_renovation.pdf");

  const env1 = await storage.createEnvelope({
    subject: "Villa Montpellier - Phase 2 Structural Plans",
    externalRef: "PROJ-2024-042",
    status: "queried",
    originalPdfUrl: pdf1Url,
    signedPdfUrl: null,
    totalPages: 5,
    webhookUrl: null,
    gmailThreadId: null,
  });

  const signer1 = await storage.createSigner({
    envelopeId: env1.id,
    email: "jean.dupont@construction-sud.fr",
    fullName: "Jean Dupont",
    accessToken: generateToken(),
  });

  await storage.createCommunicationLog({
    envelopeId: env1.id,
    senderEmail: "jean.dupont@construction-sud.fr",
    messageBody: "Could you clarify the load-bearing wall specification on page 3? The dimensions seem inconsistent with the foundation plan.",
    isExternalQuery: true,
    gmailMessageId: null,
  });

  await storage.createAuditEvent({
    envelopeId: env1.id,
    eventType: "Envelope created",
    actorEmail: "architect@cabinet-moderne.fr",
    ipAddress: "192.168.1.10",
    metadata: null,
  });
  await storage.createAuditEvent({
    envelopeId: env1.id,
    eventType: "Envelope sent for signing",
    actorEmail: "architect@cabinet-moderne.fr",
    ipAddress: "192.168.1.10",
    metadata: null,
  });
  await storage.createAuditEvent({
    envelopeId: env1.id,
    eventType: "Identity verified via OTP",
    actorEmail: "jean.dupont@construction-sud.fr",
    ipAddress: "78.234.12.45",
    metadata: null,
  });
  await storage.createAuditEvent({
    envelopeId: env1.id,
    eventType: "Clarification requested",
    actorEmail: "jean.dupont@construction-sud.fr",
    ipAddress: "78.234.12.45",
    metadata: null,
  });

  const env2 = await storage.createEnvelope({
    subject: "R\u00e9sidence Les Oliviers - Contract Amendment",
    externalRef: "PROJ-2024-038",
    status: "signed",
    originalPdfUrl: pdf2Url,
    signedPdfUrl: null,
    totalPages: 3,
    webhookUrl: null,
    gmailThreadId: null,
  });

  const signer2 = await storage.createSigner({
    envelopeId: env2.id,
    email: "marie.leroy@immobilier-provence.fr",
    fullName: "Marie Leroy",
    accessToken: generateToken(),
  });

  await storage.updateSigner(signer2.id, {
    otpVerified: true,
    signedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    lastViewedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  });

  await storage.createAuditEvent({
    envelopeId: env2.id,
    eventType: "Envelope created",
    actorEmail: "architect@cabinet-moderne.fr",
    ipAddress: "192.168.1.10",
    metadata: null,
  });
  await storage.createAuditEvent({
    envelopeId: env2.id,
    eventType: "Document signed",
    actorEmail: "marie.leroy@immobilier-provence.fr",
    ipAddress: "91.167.45.23",
    metadata: null,
  });

  const env3 = await storage.createEnvelope({
    subject: "Centre Commercial \u00c9toile - Electrical Plans",
    externalRef: "PROJ-2025-003",
    status: "sent",
    originalPdfUrl: pdf3Url,
    signedPdfUrl: null,
    totalPages: 8,
    webhookUrl: null,
    gmailThreadId: null,
  });

  await storage.createSigner({
    envelopeId: env3.id,
    email: "philippe.martin@elec-pro.fr",
    fullName: "Philippe Martin",
    accessToken: generateToken(),
  });
  await storage.createSigner({
    envelopeId: env3.id,
    email: "sophie.bernard@city-eng.fr",
    fullName: "Sophie Bernard",
    accessToken: generateToken(),
  });

  await storage.createAuditEvent({
    envelopeId: env3.id,
    eventType: "Envelope created",
    actorEmail: "architect@cabinet-moderne.fr",
    ipAddress: "192.168.1.10",
    metadata: null,
  });
  await storage.createAuditEvent({
    envelopeId: env3.id,
    eventType: "Envelope sent for signing",
    actorEmail: "architect@cabinet-moderne.fr",
    ipAddress: "192.168.1.10",
    metadata: null,
  });

  const env4 = await storage.createEnvelope({
    subject: "Maison Vaucluse - Landscape Design Approval",
    externalRef: "PROJ-2024-051",
    status: "viewed",
    originalPdfUrl: pdf4Url,
    signedPdfUrl: null,
    totalPages: 2,
    webhookUrl: null,
    gmailThreadId: null,
  });

  const signer4 = await storage.createSigner({
    envelopeId: env4.id,
    email: "claude.rousseau@jardin-design.fr",
    fullName: "Claude Rousseau",
    accessToken: generateToken(),
  });

  await storage.updateSigner(signer4.id, {
    otpVerified: true,
    lastViewedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
  });

  const env5 = await storage.createEnvelope({
    subject: "Bureau Haussmann - Interior Renovation Plans",
    externalRef: null,
    status: "draft",
    originalPdfUrl: pdf5Url,
    signedPdfUrl: null,
    totalPages: 4,
    webhookUrl: null,
    gmailThreadId: null,
  });

  await storage.createSigner({
    envelopeId: env5.id,
    email: "laurent.petit@design-interieur.fr",
    fullName: "Laurent Petit",
    accessToken: generateToken(),
  });

  console.log("Database seeded successfully with 5 sample envelopes (with PDFs).");
}
