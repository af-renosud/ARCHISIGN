import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, real, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export * from "./models/auth";

export const envelopeStatusEnum = pgEnum("envelope_status", [
  "draft", "sent", "viewed", "queried", "signed", "declined", "expired", "void"
]);

export const annotationTypeEnum = pgEnum("annotation_type", [
  "initial", "signature", "date"
]);

export const webhookDeliveryStateEnum = pgEnum("webhook_delivery_state", [
  "pending", "succeeded", "dead_lettered"
]);

export const signaturePlacementModeEnum = pgEnum("signature_placement_mode", [
  "fixed_bottom_centre", "admin_placed"
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
  expiresAt: timestamp("expires_at"),
  declineReason: text("decline_reason"),
  origin: text("origin"),
  retentionBreachAt: timestamp("retention_breach_at"),
  retentionIncidentRef: text("retention_incident_ref"),
  retentionDetectedAt: timestamp("retention_detected_at"),
  signaturePlacementMode: signaturePlacementModeEnum("signature_placement_mode").notNull().default("fixed_bottom_centre"),
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
  otpIssuedAt: timestamp("otp_issued_at"),
  otpVerifiedAt: timestamp("otp_verified_at"),
  signerIpAddress: text("signer_ip_address"),
  signerUserAgent: text("signer_user_agent"),
  lastViewedAt: timestamp("last_viewed_at"),
  signedAt: timestamp("signed_at"),
  accessTokenRotatedAt: timestamp("access_token_rotated_at"),
  previousAccessTokenHash: text("previous_access_token_hash"),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  eventId: text("event_id").notNull().unique(),
  envelopeId: integer("envelope_id").references(() => envelopes.id, { onDelete: "set null" }),
  event: text("event").notNull(),
  webhookUrl: text("webhook_url").notNull(),
  payload: text("payload").notNull(),
  state: webhookDeliveryStateEnum("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at"),
  lastError: text("last_error"),
  lastStatusCode: integer("last_status_code"),
  succeededAt: timestamp("succeeded_at"),
  deadLetteredAt: timestamp("dead_lettered_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const annotations = pgTable("annotations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  envelopeId: integer("envelope_id").notNull().references(() => envelopes.id, { onDelete: "cascade" }),
  signerId: integer("signer_id").notNull().references(() => signers.id, { onDelete: "cascade" }),
  pageNumber: integer("page_number").notNull(),
  xPos: real("x_pos").notNull(),
  yPos: real("y_pos").notNull(),
  width: real("width"),
  height: real("height"),
  type: annotationTypeEnum("type").notNull(),
  value: text("value"),
  placed: boolean("placed").notNull().default(false),
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
  envelopeId: integer("envelope_id").references(() => envelopes.id, { onDelete: "cascade" }),
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

export const contactSourceEnum = pgEnum("contact_source", ["archidoc", "local"]);
export const contactCategoryEnum = pgEnum("contact_category", [
  "client", "contractor", "partner", "internal", "other"
]);

export const contacts = pgTable("contacts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  archidocUserId: text("archidoc_user_id"),
  // v1.3.1: archidoc-sourced contacts (system actors / contractors) may have no email.
  email: text("email"),
  displayName: text("display_name").notNull(),
  organization: text("organization"),
  category: contactCategoryEnum("category").notNull().default("other"),
  role: text("role"),
  phone: text("phone"),
  source: contactSourceEnum("source").notNull(),
  archidocSourceUpdatedAt: timestamp("archidoc_source_updated_at"),
  lastUsedAt: timestamp("last_used_at"),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // v1.3.2: shared company inboxes are first-class. The local-only typo guard
  // remains via a partial unique on active local rows; archidoc rows may freely
  // share email (identity is keyed on archidoc_user_id per §8.3 / §8.9.4).
  uniqueIndex("contacts_local_email_unique")
    .on(t.email)
    .where(sql`source = 'local' AND archived_at IS NULL`),
  uniqueIndex("contacts_archidoc_user_id_unique").on(t.archidocUserId),
  index("contacts_email_lower_idx").on(sql`lower(${t.email})`),
  index("contacts_display_name_lower_idx").on(sql`lower(${t.displayName})`),
]);

export const insertContactSchema = createInsertSchema(contacts).omit({
  createdAt: true, updatedAt: true,
});
export type Contact = typeof contacts.$inferSelect;
export type InsertContact = z.infer<typeof insertContactSchema>;

export const localContactCreateSchema = z.object({
  email: z.string().email("Invalid email"),
  displayName: z.string().min(1, "Display name is required"),
  organization: z.string().nullish(),
  category: z.enum(["client", "contractor", "partner", "internal", "other"]).default("other"),
  role: z.string().nullish(),
  phone: z.string().nullish(),
});

export const localContactUpdateSchema = z.object({
  email: z.string().email("Invalid email").optional(),
  displayName: z.string().min(1).optional(),
  organization: z.string().nullish(),
  category: z.enum(["client", "contractor", "partner", "internal", "other"]).optional(),
  role: z.string().nullish(),
  phone: z.string().nullish(),
});

// v1.3.1: email is optional (system actors / contractors may have none); `id` in body
// is accepted but ignored on PUT (URL param wins; conflict triggers 400 if mismatch).
export const archidocContactUpsertSchema = z.object({
  id: z.string().min(1).optional(),
  email: z.string().email().nullish(),
  displayName: z.string().min(1),
  organization: z.string().nullish(),
  category: z.enum(["client", "contractor", "partner", "internal", "other"]),
  role: z.string().nullish(),
  phone: z.string().nullish(),
  sourceUpdatedAt: z.string().datetime({ offset: true }),
});

// v1.3.1: bulk request accepts EITHER `contacts` OR `rows` (ArchiDoc emits `rows`),
// optional top-level `batchId` (also honoured via X-Batch-Id header) drives
// `(tenant, batchId, archidocUserId)` server-side dedup so re-runs are safe.
export const archidocContactBulkSchema = z.object({
  batchId: z.string().min(1).max(200).optional(),
  contacts: z.array(z.object({
    id: z.string().min(1),
    email: z.string().email().nullish(),
    displayName: z.string().min(1),
    organization: z.string().nullish(),
    category: z.enum(["client", "contractor", "partner", "internal", "other"]),
    role: z.string().nullish(),
    phone: z.string().nullish(),
    sourceUpdatedAt: z.string().datetime({ offset: true }),
  })).min(1),
});

// v1.3.1: persistent (tenant, batchId, archidocUserId) idempotency ledger for bulk re-runs.
export const contactBulkDedup = pgTable("contact_bulk_dedup", {
  tenant: text("tenant").notNull(),
  batchId: text("batch_id").notNull(),
  archidocUserId: text("archidoc_user_id").notNull(),
  outcome: text("outcome").notNull(),
  reason: text("reason"),
  contactId: integer("contact_id"),
  errorMessage: text("error_message"),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("contact_bulk_dedup_pk").on(t.tenant, t.batchId, t.archidocUserId),
  index("contact_bulk_dedup_processed_at_idx").on(t.processedAt),
]);
export type ContactBulkDedup = typeof contactBulkDedup.$inferSelect;
export type InsertContactBulkDedup = typeof contactBulkDedup.$inferInsert;

export const insertSettingSchema = createInsertSchema(settings);
export type Setting = typeof settings.$inferSelect;
export type InsertSetting = z.infer<typeof insertSettingSchema>;

export const wishlistKindEnum = pgEnum("wishlist_kind", ["function", "amendment"]);
export const wishlistStatusEnum = pgEnum("wishlist_status", ["open", "in_progress", "done", "rejected"]);

export const wishlistItems = pgTable("wishlist_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  description: text("description"),
  kind: wishlistKindEnum("kind").notNull().default("function"),
  status: wishlistStatusEnum("status").notNull().default("open"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertWishlistItemSchema = createInsertSchema(wishlistItems).omit({
  createdAt: true, updatedAt: true,
});
export type WishlistItem = typeof wishlistItems.$inferSelect;
export type InsertWishlistItem = z.infer<typeof insertWishlistItemSchema>;

export const wishlistCreateRequestSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  description: z.string().max(5000).nullish(),
  kind: z.enum(["function", "amendment"]).default("function"),
});

export const wishlistUpdateRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullish(),
  kind: z.enum(["function", "amendment"]).optional(),
  status: z.enum(["open", "in_progress", "done", "rejected"]).optional(),
});

export const insertRollbackVersionSchema = createInsertSchema(rollbackVersions).omit({ createdAt: true });
export type RollbackVersion = typeof rollbackVersions.$inferSelect;
export type InsertRollbackVersion = z.infer<typeof insertRollbackVersionSchema>;

export const insertBackupSchema = createInsertSchema(backups).omit({ createdAt: true });
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

export const insertEnvelopeSchema = createInsertSchema(envelopes).omit({ createdAt: true, updatedAt: true });
export const insertSignerSchema = createInsertSchema(signers).omit({
  lastViewedAt: true, signedAt: true,
  otpCode: true, otpExpiresAt: true, otpVerified: true,
  otpIssuedAt: true, otpVerifiedAt: true,
  signerIpAddress: true, signerUserAgent: true,
  accessTokenRotatedAt: true, previousAccessTokenHash: true,
});
export const insertAnnotationSchema = createInsertSchema(annotations).omit({ createdAt: true });
export const insertCommunicationLogSchema = createInsertSchema(communicationLogs).omit({ timestamp: true });
export const insertAuditEventSchema = createInsertSchema(auditEvents).omit({ timestamp: true });
export const insertWebhookDeliverySchema = createInsertSchema(webhookDeliveries).omit({
  createdAt: true, updatedAt: true, succeededAt: true, deadLetteredAt: true, lastAttemptAt: true,
});

export const createEnvelopeRequestSchema = z.object({
  subject: z.string().min(1, "Subject is required"),
  externalRef: z.string().nullish(),
  message: z.string().nullish(),
  webhookUrl: z.string().url("Invalid webhook URL").nullish().or(z.literal("")),
  signaturePlacementMode: z.enum(["fixed_bottom_centre", "admin_placed"]).optional(),
});

export const createSignerRequestSchema = z.object({
  email: z.string().email("Invalid signer email"),
  fullName: z.string().min(1, "Signer name is required"),
});

export const createApiEnvelopeRequestSchema = z.object({
  subject: z.string().min(1, "Subject is required").optional(),
  signerEmail: z.string().email("Invalid signer email").optional(),
  signerName: z.string().optional(),
  signers: z.array(z.object({
    email: z.string().email("Invalid signer email"),
    fullName: z.string().min(1, "Signer name is required"),
  })).optional(),
  externalRef: z.string().nullish(),
  pdfUrl: z.string().nullish(),
  pdfBase64: z.string().nullish(),
  pdfFetchUrl: z.string().url("Invalid pdfFetchUrl").nullish(),
  webhookUrl: z.string().url("Invalid webhook URL").nullish().or(z.literal("")),
  expiresAt: z.string().datetime({ offset: true }).nullish(),
  metadata: z.record(z.unknown()).nullish(),
  identityVerification: z.object({
    method: z.literal("otp_email"),
  }).nullish(),
  fields: z.array(z.object({
    signerEmail: z.string().email().optional(),
    signerIndex: z.number().int().nonnegative().optional(),
    pageNumber: z.number().int().positive(),
    type: z.enum(["initial", "signature", "date"]),
    xPos: z.number(),
    yPos: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  })).nullish(),
  origin: z.string().nullish(),
}).refine(
  (data) => (data.signers && data.signers.length > 0) || data.signerEmail,
  { message: "At least one signer is required: provide 'signers' array or 'signerEmail'", path: ["signers"] }
).refine(
  (data) => !!(data.pdfFetchUrl || data.pdfUrl || data.pdfBase64),
  { message: "PDF source required: provide 'pdfFetchUrl', 'pdfUrl', or 'pdfBase64'", path: ["pdfFetchUrl"] }
);

export const sendEnvelopeRequestSchema = z.object({}).passthrough();

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
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type InsertWebhookDelivery = z.infer<typeof insertWebhookDeliverySchema>;
