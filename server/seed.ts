import { storage } from "./storage";
import { db } from "./db";
import { envelopes, settings } from "@shared/schema";
import { sql } from "drizzle-orm";
import fsPromises from "fs/promises";
import path from "path";

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
  console.log("Default email settings seeded.");
}

async function cleanupSampleData() {
  const result = await db.select({ count: sql<number>`count(*)` }).from(envelopes);
  const count = result[0].count;
  if (count === 0) return;

  const allEnvelopes = await db.select().from(envelopes);
  const samplePrefixes = ["sample_", "api_test_"];
  let cleaned = false;

  for (const env of allEnvelopes) {
    if (env.originalPdfUrl) {
      const filename = path.basename(env.originalPdfUrl);
      if (samplePrefixes.some(p => filename.startsWith(p))) {
        const filePath = path.join("uploads", filename);
        await fsPromises.unlink(filePath).catch(() => {});
      }
    }
  }

  const { sql: sqlTag } = await import("drizzle-orm");
  const deleted = await db.delete(envelopes).returning();
  if (deleted.length > 0) {
    cleaned = true;
    console.log(`Cleaned up ${deleted.length} sample envelopes (cascade: signers, annotations, logs, events).`);
  }

  const uploadsDir = path.join(process.cwd(), "uploads");
  try {
    const files = await fsPromises.readdir(uploadsDir);
    for (const f of files) {
      if (f.startsWith("sample_")) {
        await fsPromises.unlink(path.join(uploadsDir, f)).catch(() => {});
      }
    }
  } catch {}

  const backupsDir = path.join(process.cwd(), "backups");
  try {
    const files = await fsPromises.readdir(backupsDir);
    for (const f of files) {
      await fsPromises.unlink(path.join(backupsDir, f)).catch(() => {});
    }
  } catch {}

  if (cleaned) {
    console.log("Production cleanup complete — database is clean.");
  }
}

export async function seedDatabase() {
  await fsPromises.mkdir("uploads", { recursive: true });
  await fsPromises.mkdir("backups", { recursive: true });
  await cleanupSampleData();
  await seedSettings();
}
