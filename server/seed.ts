import { storage } from "./storage";
import { db } from "./db";
import { settings } from "@shared/schema";
import { sql } from "drizzle-orm";
import fsPromises from "fs/promises";

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

export async function seedDatabase() {
  await fsPromises.mkdir("uploads", { recursive: true });
  await fsPromises.mkdir("backups", { recursive: true });
  await seedSettings();
}
