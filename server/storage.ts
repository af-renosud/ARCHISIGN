import {
  envelopes, signers, annotations, communicationLogs, auditEvents, settings,
  type Envelope, type InsertEnvelope,
  type Signer, type InsertSigner,
  type Annotation, type InsertAnnotation,
  type CommunicationLog, type InsertCommunicationLog,
  type AuditEvent, type InsertAuditEvent,
  type Setting, type InsertSetting,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, sql } from "drizzle-orm";

export interface IStorage {
  getEnvelopes(): Promise<(Envelope & { signers: Signer[] })[]>;
  getEnvelope(id: number): Promise<(Envelope & { signers: Signer[]; communicationLogs: CommunicationLog[]; auditEvents: AuditEvent[] }) | undefined>;
  createEnvelope(data: InsertEnvelope): Promise<Envelope>;
  updateEnvelope(id: number, data: Partial<Envelope>): Promise<Envelope | undefined>;

  createSigner(data: InsertSigner): Promise<Signer>;
  getSignerByToken(token: string): Promise<Signer | undefined>;
  getSignersByEnvelope(envelopeId: number): Promise<Signer[]>;
  updateSigner(id: number, data: Partial<Signer>): Promise<Signer | undefined>;

  createAnnotation(data: InsertAnnotation): Promise<Annotation>;
  getAnnotationsByEnvelopeAndSigner(envelopeId: number, signerId: number): Promise<Annotation[]>;

  createCommunicationLog(data: InsertCommunicationLog): Promise<CommunicationLog>;
  getCommunicationLogs(envelopeId: number): Promise<CommunicationLog[]>;

  createAuditEvent(data: InsertAuditEvent): Promise<AuditEvent>;
  getAuditEvents(envelopeId: number): Promise<AuditEvent[]>;

  getAllSettings(): Promise<Setting[]>;
  getSetting(key: string): Promise<Setting | undefined>;
  upsertSetting(data: InsertSetting): Promise<Setting>;
  getSettingsByCategory(category: string): Promise<Setting[]>;
}

export class DatabaseStorage implements IStorage {
  async getEnvelopes(): Promise<(Envelope & { signers: Signer[] })[]> {
    const allEnvelopes = await db.select().from(envelopes).orderBy(desc(envelopes.createdAt));
    const result = [];
    for (const env of allEnvelopes) {
      const envSigners = await db.select().from(signers).where(eq(signers.envelopeId, env.id));
      result.push({ ...env, signers: envSigners });
    }
    return result;
  }

  async getEnvelope(id: number) {
    const [envelope] = await db.select().from(envelopes).where(eq(envelopes.id, id));
    if (!envelope) return undefined;
    const envSigners = await db.select().from(signers).where(eq(signers.envelopeId, id));
    const logs = await db.select().from(communicationLogs).where(eq(communicationLogs.envelopeId, id)).orderBy(desc(communicationLogs.timestamp));
    const events = await db.select().from(auditEvents).where(eq(auditEvents.envelopeId, id)).orderBy(desc(auditEvents.timestamp));
    return { ...envelope, signers: envSigners, communicationLogs: logs, auditEvents: events };
  }

  async createEnvelope(data: InsertEnvelope): Promise<Envelope> {
    const [envelope] = await db.insert(envelopes).values(data).returning();
    return envelope;
  }

  async updateEnvelope(id: number, data: Partial<Envelope>): Promise<Envelope | undefined> {
    const [updated] = await db.update(envelopes).set({ ...data, updatedAt: new Date() }).where(eq(envelopes.id, id)).returning();
    return updated;
  }

  async createSigner(data: InsertSigner): Promise<Signer> {
    const [signer] = await db.insert(signers).values(data).returning();
    return signer;
  }

  async getSignerByToken(token: string): Promise<Signer | undefined> {
    const [signer] = await db.select().from(signers).where(eq(signers.accessToken, token));
    return signer;
  }

  async getSignersByEnvelope(envelopeId: number): Promise<Signer[]> {
    return db.select().from(signers).where(eq(signers.envelopeId, envelopeId));
  }

  async updateSigner(id: number, data: Partial<Signer>): Promise<Signer | undefined> {
    const [updated] = await db.update(signers).set(data).where(eq(signers.id, id)).returning();
    return updated;
  }

  async createAnnotation(data: InsertAnnotation): Promise<Annotation> {
    const [annotation] = await db.insert(annotations).values(data).returning();
    return annotation;
  }

  async getAnnotationsByEnvelopeAndSigner(envelopeId: number, signerId: number): Promise<Annotation[]> {
    return db.select().from(annotations).where(
      and(eq(annotations.envelopeId, envelopeId), eq(annotations.signerId, signerId))
    );
  }

  async createCommunicationLog(data: InsertCommunicationLog): Promise<CommunicationLog> {
    const [log] = await db.insert(communicationLogs).values(data).returning();
    return log;
  }

  async getCommunicationLogs(envelopeId: number): Promise<CommunicationLog[]> {
    return db.select().from(communicationLogs).where(eq(communicationLogs.envelopeId, envelopeId)).orderBy(desc(communicationLogs.timestamp));
  }

  async createAuditEvent(data: InsertAuditEvent): Promise<AuditEvent> {
    const [event] = await db.insert(auditEvents).values(data).returning();
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
}

export const storage = new DatabaseStorage();
