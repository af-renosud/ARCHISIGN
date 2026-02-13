import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, real, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export * from "./models/auth";

export const envelopeStatusEnum = pgEnum("envelope_status", [
  "draft", "sent", "viewed", "queried", "signed", "declined"
]);

export const annotationTypeEnum = pgEnum("annotation_type", [
  "initial", "signature", "date"
]);

export const envelopes = pgTable("envelopes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  externalRef: text("external_ref"),
  subject: text("subject").notNull(),
  message: text("message"),
  status: envelopeStatusEnum("status").notNull().default("draft"),
  originalPdfUrl: text("original_pdf_url"),
  signedPdfUrl: text("signed_pdf_url"),
  totalPages: integer("total_pages").notNull().default(1),
  webhookUrl: text("webhook_url"),
  gmailThreadId: text("gmail_thread_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

export const signers = pgTable("signers", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  envelopeId: integer("envelope_id").notNull().references(() => envelopes.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  fullName: text("full_name").notNull(),
  accessToken: text("access_token").notNull().unique(),
  otpCode: text("otp_code"),
  otpExpiresAt: timestamp("otp_expires_at"),
  otpVerified: boolean("otp_verified").notNull().default(false),
  lastViewedAt: timestamp("last_viewed_at"),
  signedAt: timestamp("signed_at"),
});

export const annotations = pgTable("annotations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  envelopeId: integer("envelope_id").notNull().references(() => envelopes.id, { onDelete: "cascade" }),
  signerId: integer("signer_id").notNull().references(() => signers.id, { onDelete: "cascade" }),
  pageNumber: integer("page_number").notNull(),
  xPos: real("x_pos").notNull(),
  yPos: real("y_pos").notNull(),
  type: annotationTypeEnum("type").notNull(),
  value: text("value"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const communicationLogs = pgTable("communication_logs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  envelopeId: integer("envelope_id").notNull().references(() => envelopes.id, { onDelete: "cascade" }),
  senderEmail: text("sender_email").notNull(),
  messageBody: text("message_body").notNull(),
  isExternalQuery: boolean("is_external_query").notNull().default(false),
  gmailMessageId: text("gmail_message_id"),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
});

export const auditEvents = pgTable("audit_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  envelopeId: integer("envelope_id").notNull().references(() => envelopes.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  actorEmail: text("actor_email"),
  ipAddress: text("ip_address"),
  metadata: text("metadata"),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  label: text("label").notNull(),
  category: text("category").notNull().default("general"),
});

export const rollbackVersionStatusEnum = pgEnum("rollback_version_status", [
  "active", "superseded"
]);

export const rollbackVersions = pgTable("rollback_versions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  versionLabel: text("version_label").notNull(),
  note: text("note"),
  status: rollbackVersionStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const backups = pgTable("backups", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  filename: text("filename").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSettingSchema = createInsertSchema(settings);
export type Setting = typeof settings.$inferSelect;
export type InsertSetting = z.infer<typeof insertSettingSchema>;

export const insertRollbackVersionSchema = createInsertSchema(rollbackVersions).omit({ id: true, createdAt: true });
export type RollbackVersion = typeof rollbackVersions.$inferSelect;
export type InsertRollbackVersion = z.infer<typeof insertRollbackVersionSchema>;

export const insertBackupSchema = createInsertSchema(backups).omit({ id: true, createdAt: true });
export type Backup = typeof backups.$inferSelect;
export type InsertBackup = z.infer<typeof insertBackupSchema>;

export const envelopeRelations = relations(envelopes, ({ many }) => ({
  signers: many(signers),
  annotations: many(annotations),
  communicationLogs: many(communicationLogs),
  auditEvents: many(auditEvents),
}));

export const signerRelations = relations(signers, ({ one, many }) => ({
  envelope: one(envelopes, { fields: [signers.envelopeId], references: [envelopes.id] }),
  annotations: many(annotations),
}));

export const annotationRelations = relations(annotations, ({ one }) => ({
  envelope: one(envelopes, { fields: [annotations.envelopeId], references: [envelopes.id] }),
  signer: one(signers, { fields: [annotations.signerId], references: [signers.id] }),
}));

export const communicationLogRelations = relations(communicationLogs, ({ one }) => ({
  envelope: one(envelopes, { fields: [communicationLogs.envelopeId], references: [envelopes.id] }),
}));

export const auditEventRelations = relations(auditEvents, ({ one }) => ({
  envelope: one(envelopes, { fields: [auditEvents.envelopeId], references: [envelopes.id] }),
}));

export const insertEnvelopeSchema = createInsertSchema(envelopes).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSignerSchema = createInsertSchema(signers).omit({ id: true, lastViewedAt: true, signedAt: true, otpCode: true, otpExpiresAt: true, otpVerified: true });
export const insertAnnotationSchema = createInsertSchema(annotations).omit({ id: true, createdAt: true });
export const insertCommunicationLogSchema = createInsertSchema(communicationLogs).omit({ id: true, timestamp: true });
export const insertAuditEventSchema = createInsertSchema(auditEvents).omit({ id: true, timestamp: true });

export const createEnvelopeRequestSchema = z.object({
  subject: z.string().min(1, "Subject is required"),
  externalRef: z.string().nullish(),
  message: z.string().nullish(),
  webhookUrl: z.string().url("Invalid webhook URL").nullish().or(z.literal("")),
});

export const createSignerRequestSchema = z.object({
  email: z.string().email("Invalid signer email"),
  fullName: z.string().min(1, "Signer name is required"),
});

export const createApiEnvelopeRequestSchema = z.object({
  subject: z.string().min(1, "Subject is required"),
  signerEmail: z.string().email("Invalid signer email"),
  signerName: z.string().optional(),
  externalRef: z.string().nullish(),
  pdfUrl: z.string().nullish(),
  webhookUrl: z.string().url("Invalid webhook URL").nullish().or(z.literal("")),
});

export type Envelope = typeof envelopes.$inferSelect;
export type InsertEnvelope = z.infer<typeof insertEnvelopeSchema>;
export type Signer = typeof signers.$inferSelect;
export type InsertSigner = z.infer<typeof insertSignerSchema>;
export type Annotation = typeof annotations.$inferSelect;
export type InsertAnnotation = z.infer<typeof insertAnnotationSchema>;
export type CommunicationLog = typeof communicationLogs.$inferSelect;
export type InsertCommunicationLog = z.infer<typeof insertCommunicationLogSchema>;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type InsertAuditEvent = z.infer<typeof insertAuditEventSchema>;
