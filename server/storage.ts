import {
  envelopes, signers, annotations, communicationLogs, auditEvents, settings,
  rollbackVersions, backups, webhookDeliveries, contacts, contactBulkDedup, wishlistItems,
  type Envelope, type InsertEnvelope,
  type Signer, type InsertSigner,
  type Annotation, type InsertAnnotation,
  type CommunicationLog, type InsertCommunicationLog,
  type AuditEvent, type InsertAuditEvent,
  type Setting, type InsertSetting,
  type RollbackVersion, type InsertRollbackVersion,
  type Backup, type InsertBackup,
  type WebhookDelivery, type InsertWebhookDelivery,
  type Contact, type InsertContact,
  type ContactBulkDedup, type InsertContactBulkDedup,
  type WishlistItem, type InsertWishlistItem,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, or, sql, isNull, isNotNull, inArray, lt, ilike } from "drizzle-orm";

export type DbExecutor = typeof db;

export interface IStorage {
  getEnvelopes(): Promise<(Envelope & { signers: Signer[] })[]>;
  getEnvelope(id: number): Promise<(Envelope & { signers: Signer[]; communicationLogs: CommunicationLog[]; auditEvents: AuditEvent[] }) | undefined>;
  createEnvelope(data: InsertEnvelope, executor?: DbExecutor): Promise<Envelope>;
  updateEnvelope(id: number, data: Partial<Envelope>, executor?: DbExecutor): Promise<Envelope | undefined>;

  createSigner(data: InsertSigner, executor?: DbExecutor): Promise<Signer>;
  getSignerByToken(token: string): Promise<Signer | undefined>;
  getSignersByEnvelope(envelopeId: number, executor?: DbExecutor): Promise<Signer[]>;
  updateSigner(id: number, data: Partial<Signer>, executor?: DbExecutor): Promise<Signer | undefined>;
  atomicClaimSign(signerId: number, executor?: DbExecutor): Promise<Signer | undefined>;

  createAnnotation(data: InsertAnnotation, executor?: DbExecutor): Promise<Annotation>;
  getAnnotationsByEnvelopeAndSigner(envelopeId: number, signerId: number, executor?: DbExecutor): Promise<Annotation[]>;
  getAnnotationsByEnvelope(envelopeId: number): Promise<Annotation[]>;
  updateAnnotation(id: number, data: Partial<Annotation>): Promise<Annotation | undefined>;
  deleteAnnotation(id: number): Promise<void>;

  createCommunicationLog(data: InsertCommunicationLog): Promise<CommunicationLog>;
  getCommunicationLogs(envelopeId: number): Promise<CommunicationLog[]>;

  createAuditEvent(data: InsertAuditEvent, executor?: DbExecutor): Promise<AuditEvent>;
  getAuditEvents(envelopeId: number): Promise<AuditEvent[]>;

  getAllSettings(): Promise<Setting[]>;
  getSetting(key: string): Promise<Setting | undefined>;
  upsertSetting(data: InsertSetting): Promise<Setting>;
  getSettingsByCategory(category: string): Promise<Setting[]>;

  getWishlistItems(): Promise<WishlistItem[]>;
  getWishlistItem(id: number): Promise<WishlistItem | undefined>;
  createWishlistItem(data: InsertWishlistItem): Promise<WishlistItem>;
  updateWishlistItem(id: number, data: Partial<WishlistItem>): Promise<WishlistItem | undefined>;
  deleteWishlistItem(id: number): Promise<void>;

  getDeletedEnvelopes(): Promise<Envelope[]>;
  softDeleteEnvelope(id: number): Promise<Envelope | undefined>;
  restoreEnvelope(id: number): Promise<Envelope | undefined>;

  getRollbackVersions(): Promise<RollbackVersion[]>;
  createRollbackVersion(data: InsertRollbackVersion): Promise<RollbackVersion>;
  updateRollbackVersion(id: number, data: Partial<RollbackVersion>): Promise<RollbackVersion | undefined>;
  deleteRollbackVersion(id: number): Promise<void>;

  getBackups(): Promise<Backup[]>;
  createBackup(data: InsertBackup): Promise<Backup>;
  deleteBackup(id: number): Promise<void>;

  createWebhookDelivery(data: InsertWebhookDelivery, executor?: DbExecutor): Promise<WebhookDelivery>;
  /**
   * Atomically claim a delivery row by eventId. Uses INSERT ... ON CONFLICT DO NOTHING.
   * Returns the inserted row when this caller wins the race, or null when another caller
   * has already claimed it. Caller must then re-fetch with getWebhookDeliveryByEventId
   * to inspect the existing state.
   */
  claimWebhookDelivery(data: InsertWebhookDelivery): Promise<WebhookDelivery | null>;
  getWebhookDeliveryByEventId(eventId: string): Promise<WebhookDelivery | undefined>;
  getWebhookDelivery(id: number): Promise<WebhookDelivery | undefined>;
  markWebhookDeliveryAttempt(id: number, statusCode: number | null, errorMessage: string | null): Promise<WebhookDelivery | undefined>;
  markWebhookDeliverySucceeded(id: number, statusCode: number): Promise<WebhookDelivery | undefined>;
  markWebhookDeliveryDeadLettered(id: number, errorMessage: string): Promise<WebhookDelivery | undefined>;
  listDeadLetteredDeliveries(): Promise<WebhookDelivery[]>;
  resetDeliveryForRetry(id: number): Promise<WebhookDelivery | undefined>;

  /**
   * Atomically transition an envelope from `draft` to `sent`.
   * Returns the updated envelope row when this caller wins the transition,
   * or null when the envelope was not in `draft` (already sent / terminal /
   * concurrent caller won). Allows /send first-send semantics to be race-tight
   * even under concurrent requests.
   */
  atomicClaimEnvelopeSend(envelopeId: number, now: Date): Promise<Envelope | null>;
  markEnvelopeExpiredAtomic(now: Date): Promise<Envelope[]>;
  markEnvelopeRetentionBreach(envelopeId: number, incidentRef: string, detectedAt: Date): Promise<Envelope | undefined>;
  getEnvelopesForIntegrityCheck(limit: number, offset: number): Promise<Envelope[]>;
  rotateSignerAccessToken(signerId: number, newToken: string, previousTokenHash: string, executor?: DbExecutor): Promise<Signer | undefined>;

  searchContacts(opts: { q?: string; source?: "archidoc" | "local"; includeArchived?: boolean; limit?: number }): Promise<Contact[]>;
  getContactById(id: number): Promise<Contact | undefined>;
  getContactByArchidocUserId(archidocUserId: string): Promise<Contact | undefined>;
  getContactBySourceEmail(source: "archidoc" | "local", email: string): Promise<Contact | undefined>;
  createContact(data: InsertContact): Promise<Contact>;
  updateContact(id: number, data: Partial<Contact>): Promise<Contact | undefined>;
  archiveContact(id: number): Promise<Contact | undefined>;
  bumpContactLastUsedByEmail(email: string): Promise<void>;
  getBulkDedupRow(tenant: string, batchId: string, archidocUserId: string): Promise<ContactBulkDedup | undefined>;
  recordBulkDedupRow(row: InsertContactBulkDedup): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getEnvelopes(): Promise<(Envelope & { signers: Signer[] })[]> {
    const allEnvelopes = await db.select().from(envelopes).where(isNull(envelopes.deletedAt)).orderBy(desc(envelopes.createdAt));
    if (allEnvelopes.length === 0) return [];
    const envelopeIds = allEnvelopes.map(e => e.id);
    const allSigners = await db.select().from(signers).where(inArray(signers.envelopeId, envelopeIds));
    const signersByEnvelopeId = new Map<number, Signer[]>();
    for (const s of allSigners) {
      const list = signersByEnvelopeId.get(s.envelopeId) || [];
      list.push(s);
      signersByEnvelopeId.set(s.envelopeId, list);
    }
    return allEnvelopes.map(env => ({
      ...env,
      signers: signersByEnvelopeId.get(env.id) || [],
    }));
  }

  async getEnvelope(id: number) {
    const [envelope] = await db.select().from(envelopes).where(eq(envelopes.id, id));
    if (!envelope) return undefined;
    const [envSigners, logs, events] = await Promise.all([
      db.select().from(signers).where(eq(signers.envelopeId, id)),
      db.select().from(communicationLogs).where(eq(communicationLogs.envelopeId, id)).orderBy(desc(communicationLogs.timestamp)),
      db.select().from(auditEvents).where(eq(auditEvents.envelopeId, id)).orderBy(desc(auditEvents.timestamp)),
    ]);
    return { ...envelope, signers: envSigners, communicationLogs: logs, auditEvents: events };
  }

  async createEnvelope(data: InsertEnvelope, executor: DbExecutor = db): Promise<Envelope> {
    const [envelope] = await executor.insert(envelopes).values(data).returning();
    return envelope;
  }

  async updateEnvelope(id: number, data: Partial<Envelope>, executor: DbExecutor = db): Promise<Envelope | undefined> {
    const [updated] = await executor.update(envelopes).set({ ...data, updatedAt: new Date() }).where(eq(envelopes.id, id)).returning();
    return updated;
  }

  async createSigner(data: InsertSigner, executor: DbExecutor = db): Promise<Signer> {
    const [signer] = await executor.insert(signers).values(data).returning();
    return signer;
  }

  async getSignerByToken(token: string): Promise<Signer | undefined> {
    const [signer] = await db.select().from(signers).where(eq(signers.accessToken, token));
    return signer;
  }

  async getSignersByEnvelope(envelopeId: number, executor: DbExecutor = db): Promise<Signer[]> {
    return executor.select().from(signers).where(eq(signers.envelopeId, envelopeId));
  }

  async updateSigner(id: number, data: Partial<Signer>, executor: DbExecutor = db): Promise<Signer | undefined> {
    const [updated] = await executor.update(signers).set(data).where(eq(signers.id, id)).returning();
    return updated;
  }

  async atomicClaimSign(signerId: number, executor: DbExecutor = db): Promise<Signer | undefined> {
    const [updated] = await executor
      .update(signers)
      .set({ signedAt: new Date() })
      .where(and(eq(signers.id, signerId), isNull(signers.signedAt)))
      .returning();
    return updated;
  }

  async createAnnotation(data: InsertAnnotation, executor: DbExecutor = db): Promise<Annotation> {
    const [annotation] = await executor.insert(annotations).values(data).returning();
    return annotation;
  }

  async getAnnotationsByEnvelopeAndSigner(envelopeId: number, signerId: number, executor: DbExecutor = db): Promise<Annotation[]> {
    return executor.select().from(annotations).where(
      and(eq(annotations.envelopeId, envelopeId), eq(annotations.signerId, signerId))
    );
  }

  async getAnnotationsByEnvelope(envelopeId: number): Promise<Annotation[]> {
    return db.select().from(annotations).where(eq(annotations.envelopeId, envelopeId));
  }

  async updateAnnotation(id: number, data: Partial<Annotation>): Promise<Annotation | undefined> {
    const [updated] = await db.update(annotations).set(data).where(eq(annotations.id, id)).returning();
    return updated;
  }

  async deleteAnnotation(id: number): Promise<void> {
    await db.delete(annotations).where(eq(annotations.id, id));
  }

  async createCommunicationLog(data: InsertCommunicationLog): Promise<CommunicationLog> {
    const [log] = await db.insert(communicationLogs).values(data).returning();
    return log;
  }

  async getCommunicationLogs(envelopeId: number): Promise<CommunicationLog[]> {
    return db.select().from(communicationLogs).where(eq(communicationLogs.envelopeId, envelopeId)).orderBy(desc(communicationLogs.timestamp));
  }

  async createAuditEvent(data: InsertAuditEvent, executor: DbExecutor = db): Promise<AuditEvent> {
    const [event] = await executor.insert(auditEvents).values(data).returning();
    return event;
  }

  async getAuditEvents(envelopeId: number): Promise<AuditEvent[]> {
    return db.select().from(auditEvents).where(eq(auditEvents.envelopeId, envelopeId)).orderBy(desc(auditEvents.timestamp));
  }

  async getAllSettings(): Promise<Setting[]> {
    return db.select().from(settings);
  }

  async getSetting(key: string): Promise<Setting | undefined> {
    const [setting] = await db.select().from(settings).where(eq(settings.key, key));
    return setting;
  }

  async upsertSetting(data: InsertSetting): Promise<Setting> {
    const [setting] = await db
      .insert(settings)
      .values(data)
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: data.value, label: data.label, category: data.category },
      })
      .returning();
    return setting;
  }

  async getSettingsByCategory(category: string): Promise<Setting[]> {
    return db.select().from(settings).where(eq(settings.category, category));
  }

  async getWishlistItems(): Promise<WishlistItem[]> {
    return db.select().from(wishlistItems).orderBy(desc(wishlistItems.createdAt));
  }

  async getWishlistItem(id: number): Promise<WishlistItem | undefined> {
    const [item] = await db.select().from(wishlistItems).where(eq(wishlistItems.id, id));
    return item;
  }

  async createWishlistItem(data: InsertWishlistItem): Promise<WishlistItem> {
    const [item] = await db.insert(wishlistItems).values(data).returning();
    return item;
  }

  async updateWishlistItem(id: number, data: Partial<WishlistItem>): Promise<WishlistItem | undefined> {
    const [item] = await db
      .update(wishlistItems)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(wishlistItems.id, id))
      .returning();
    return item;
  }

  async deleteWishlistItem(id: number): Promise<void> {
    await db.delete(wishlistItems).where(eq(wishlistItems.id, id));
  }

  async getDeletedEnvelopes(): Promise<Envelope[]> {
    return db.select().from(envelopes).where(isNotNull(envelopes.deletedAt)).orderBy(desc(envelopes.deletedAt));
  }

  async softDeleteEnvelope(id: number): Promise<Envelope | undefined> {
    const [updated] = await db.update(envelopes).set({ deletedAt: new Date() }).where(eq(envelopes.id, id)).returning();
    return updated;
  }

  async restoreEnvelope(id: number): Promise<Envelope | undefined> {
    const [updated] = await db.update(envelopes).set({ deletedAt: null }).where(eq(envelopes.id, id)).returning();
    return updated;
  }

  async getRollbackVersions(): Promise<RollbackVersion[]> {
    return db.select().from(rollbackVersions).orderBy(desc(rollbackVersions.createdAt));
  }

  async createRollbackVersion(data: InsertRollbackVersion): Promise<RollbackVersion> {
    const [version] = await db.insert(rollbackVersions).values(data).returning();
    return version;
  }

  async updateRollbackVersion(id: number, data: Partial<RollbackVersion>): Promise<RollbackVersion | undefined> {
    const [updated] = await db.update(rollbackVersions).set(data).where(eq(rollbackVersions.id, id)).returning();
    return updated;
  }

  async deleteRollbackVersion(id: number): Promise<void> {
    await db.delete(rollbackVersions).where(eq(rollbackVersions.id, id));
  }

  async getBackups(): Promise<Backup[]> {
    return db.select().from(backups).orderBy(desc(backups.createdAt));
  }

  async createBackup(data: InsertBackup): Promise<Backup> {
    const [backup] = await db.insert(backups).values(data).returning();
    return backup;
  }

  async deleteBackup(id: number): Promise<void> {
    await db.delete(backups).where(eq(backups.id, id));
  }

  async createWebhookDelivery(data: InsertWebhookDelivery, executor: DbExecutor = db): Promise<WebhookDelivery> {
    const [delivery] = await executor.insert(webhookDeliveries).values(data).returning();
    return delivery;
  }

  async claimWebhookDelivery(data: InsertWebhookDelivery): Promise<WebhookDelivery | null> {
    const [delivery] = await db.insert(webhookDeliveries)
      .values(data)
      .onConflictDoNothing({ target: webhookDeliveries.eventId })
      .returning();
    return delivery ?? null;
  }

  async getWebhookDeliveryByEventId(eventId: string): Promise<WebhookDelivery | undefined> {
    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, eventId));
    return delivery;
  }

  async getWebhookDelivery(id: number): Promise<WebhookDelivery | undefined> {
    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    return delivery;
  }

  async markWebhookDeliveryAttempt(id: number, statusCode: number | null, errorMessage: string | null): Promise<WebhookDelivery | undefined> {
    const [updated] = await db.update(webhookDeliveries)
      .set({
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        lastAttemptAt: new Date(),
        lastStatusCode: statusCode,
        lastError: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, id))
      .returning();
    return updated;
  }

  async markWebhookDeliverySucceeded(id: number, statusCode: number): Promise<WebhookDelivery | undefined> {
    const now = new Date();
    const [updated] = await db.update(webhookDeliveries)
      .set({
        state: "succeeded",
        succeededAt: now,
        lastStatusCode: statusCode,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, id))
      .returning();
    return updated;
  }

  async markWebhookDeliveryDeadLettered(id: number, errorMessage: string): Promise<WebhookDelivery | undefined> {
    const now = new Date();
    const [updated] = await db.update(webhookDeliveries)
      .set({
        state: "dead_lettered",
        deadLetteredAt: now,
        lastError: errorMessage,
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, id))
      .returning();
    return updated;
  }

  async listDeadLetteredDeliveries(): Promise<WebhookDelivery[]> {
    return db.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.state, "dead_lettered"))
      .orderBy(desc(webhookDeliveries.deadLetteredAt));
  }

  async resetDeliveryForRetry(id: number): Promise<WebhookDelivery | undefined> {
    const [updated] = await db.update(webhookDeliveries)
      .set({
        state: "pending",
        deadLetteredAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, id))
      .returning();
    return updated;
  }

  async atomicClaimEnvelopeSend(envelopeId: number, now: Date): Promise<Envelope | null> {
    const [updated] = await db.update(envelopes)
      .set({ status: "sent", updatedAt: now })
      .where(and(
        eq(envelopes.id, envelopeId),
        eq(envelopes.status, "draft"),
        isNull(envelopes.deletedAt),
      ))
      .returning();
    return updated ?? null;
  }

  async markEnvelopeExpiredAtomic(now: Date): Promise<Envelope[]> {
    const updated = await db.update(envelopes)
      .set({ status: "expired", updatedAt: now })
      .where(and(
        isNotNull(envelopes.expiresAt),
        lt(envelopes.expiresAt, now),
        sql`${envelopes.status} NOT IN ('signed', 'declined', 'expired', 'void')`,
        isNull(envelopes.deletedAt),
      ))
      .returning();
    return updated;
  }

  async markEnvelopeRetentionBreach(envelopeId: number, incidentRef: string, detectedAt: Date): Promise<Envelope | undefined> {
    const [updated] = await db.update(envelopes)
      .set({
        retentionBreachAt: detectedAt,
        retentionIncidentRef: incidentRef,
        retentionDetectedAt: detectedAt,
        updatedAt: detectedAt,
      })
      .where(eq(envelopes.id, envelopeId))
      .returning();
    return updated;
  }

  async getEnvelopesForIntegrityCheck(limit: number, offset: number): Promise<Envelope[]> {
    return db.select().from(envelopes)
      .where(and(
        eq(envelopes.status, "signed"),
        isNotNull(envelopes.signedPdfUrl),
        isNull(envelopes.retentionBreachAt),
        isNull(envelopes.deletedAt),
      ))
      .orderBy(envelopes.id)
      .limit(limit)
      .offset(offset);
  }

  async searchContacts(opts: { q?: string; source?: "archidoc" | "local"; includeArchived?: boolean; limit?: number } = {}): Promise<Contact[]> {
    const conditions: any[] = [];
    if (!opts.includeArchived) conditions.push(isNull(contacts.archivedAt));
    if (opts.source) conditions.push(eq(contacts.source, opts.source));
    if (opts.q && opts.q.trim().length > 0) {
      const term = `%${opts.q.trim().toLowerCase()}%`;
      conditions.push(or(
        sql`lower(${contacts.email}) like ${term}`,
        sql`lower(${contacts.displayName}) like ${term}`,
        sql`lower(coalesce(${contacts.organization}, '')) like ${term}`,
      ));
    }
    const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);
    const query = db.select().from(contacts);
    const rows = await (where ? query.where(where) : query)
      .orderBy(desc(contacts.lastUsedAt), desc(contacts.updatedAt))
      .limit(opts.limit ?? 200);
    return rows;
  }

  async getContactById(id: number): Promise<Contact | undefined> {
    const [c] = await db.select().from(contacts).where(eq(contacts.id, id));
    return c;
  }

  async getContactByArchidocUserId(archidocUserId: string): Promise<Contact | undefined> {
    const [c] = await db.select().from(contacts).where(eq(contacts.archidocUserId, archidocUserId));
    return c;
  }

  async getContactBySourceEmail(source: "archidoc" | "local", email: string): Promise<Contact | undefined> {
    const [c] = await db.select().from(contacts).where(
      and(eq(contacts.source, source), eq(contacts.email, email))
    );
    return c;
  }

  async createContact(data: InsertContact): Promise<Contact> {
    const [c] = await db.insert(contacts).values(data).returning();
    return c;
  }

  async updateContact(id: number, data: Partial<Contact>): Promise<Contact | undefined> {
    const [c] = await db.update(contacts).set({ ...data, updatedAt: new Date() }).where(eq(contacts.id, id)).returning();
    return c;
  }

  async archiveContact(id: number): Promise<Contact | undefined> {
    const now = new Date();
    const [c] = await db.update(contacts).set({ archivedAt: now, updatedAt: now }).where(eq(contacts.id, id)).returning();
    return c;
  }

  async bumpContactLastUsedByEmail(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    await db.update(contacts)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(contacts.email, normalized), isNull(contacts.archivedAt)));
  }

  async getBulkDedupRow(tenant: string, batchId: string, archidocUserId: string): Promise<ContactBulkDedup | undefined> {
    const [row] = await db.select().from(contactBulkDedup).where(
      and(
        eq(contactBulkDedup.tenant, tenant),
        eq(contactBulkDedup.batchId, batchId),
        eq(contactBulkDedup.archidocUserId, archidocUserId),
      ),
    );
    return row;
  }

  async recordBulkDedupRow(row: InsertContactBulkDedup): Promise<void> {
    await db.insert(contactBulkDedup).values(row).onConflictDoNothing({
      target: [contactBulkDedup.tenant, contactBulkDedup.batchId, contactBulkDedup.archidocUserId],
    });
  }

  async rotateSignerAccessToken(signerId: number, newToken: string, previousTokenHash: string, executor: DbExecutor = db): Promise<Signer | undefined> {
    const [updated] = await executor.update(signers)
      .set({
        accessToken: newToken,
        previousAccessTokenHash: previousTokenHash,
        accessTokenRotatedAt: new Date(),
        otpCode: null,
        otpExpiresAt: null,
        otpVerified: false,
        otpIssuedAt: null,
        otpVerifiedAt: null,
      })
      .where(eq(signers.id, signerId))
      .returning();
    return updated;
  }
}

export const storage = new DatabaseStorage();
