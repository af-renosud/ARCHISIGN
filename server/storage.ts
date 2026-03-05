import {
  envelopes, signers, annotations, communicationLogs, auditEvents, settings,
  rollbackVersions, backups,
  type Envelope, type InsertEnvelope,
  type Signer, type InsertSigner,
  type Annotation, type InsertAnnotation,
  type CommunicationLog, type InsertCommunicationLog,
  type AuditEvent, type InsertAuditEvent,
  type Setting, type InsertSetting,
  type RollbackVersion, type InsertRollbackVersion,
  type Backup, type InsertBackup,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, sql, isNull, isNotNull, inArray } from "drizzle-orm";

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
}

export const storage = new DatabaseStorage();
