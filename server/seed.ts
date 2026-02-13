import { storage } from "./storage";
import { db } from "./db";
import { envelopes } from "@shared/schema";
import { randomBytes } from "crypto";
import { sql } from "drizzle-orm";

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export async function seedDatabase() {
  const existing = await db.select({ count: sql<number>`count(*)` }).from(envelopes);
  if (existing[0].count > 0) return;

  console.log("Seeding database with sample data...");

  const env1 = await storage.createEnvelope({
    subject: "Villa Montpellier - Phase 2 Structural Plans",
    externalRef: "PROJ-2024-042",
    status: "queried",
    originalPdfUrl: null,
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
    subject: "Résidence Les Oliviers - Contract Amendment",
    externalRef: "PROJ-2024-038",
    status: "signed",
    originalPdfUrl: null,
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
    subject: "Centre Commercial Étoile - Electrical Plans",
    externalRef: "PROJ-2025-003",
    status: "sent",
    originalPdfUrl: null,
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
    originalPdfUrl: null,
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
    originalPdfUrl: null,
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

  console.log("Database seeded successfully with 5 sample envelopes.");
}
