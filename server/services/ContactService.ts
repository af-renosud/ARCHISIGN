import { storage } from "../storage";
import type { Contact, InsertContact } from "@shared/schema";

export type ContactCategory = "client" | "contractor" | "partner" | "internal" | "other";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeOptionalEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  const t = email.trim();
  return t.length === 0 ? null : t.toLowerCase();
}

export interface LocalContactInput {
  email: string;
  displayName: string;
  organization?: string | null;
  category?: ContactCategory;
  role?: string | null;
  phone?: string | null;
}

export interface ArchidocContactInput {
  archidocUserId: string;
  email: string | null;
  displayName: string;
  organization?: string | null;
  category: ContactCategory;
  role?: string | null;
  phone?: string | null;
  sourceUpdatedAt: string;
}

export class ContactConflictError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
  }
}

export class ContactNotFoundError extends Error {
  status = 404;
  constructor(message = "Contact not found") {
    super(message);
  }
}

export class ContactSourceMismatchError extends Error {
  status = 403;
  constructor(message: string) {
    super(message);
  }
}

export interface UpsertResult {
  applied: boolean;
  reason?: "stale";
  contact: Contact;
}

export const ContactService = {
  async createLocal(input: LocalContactInput): Promise<Contact> {
    const email = normalizeEmail(input.email);
    const existing = await storage.getContactBySourceEmail("local", email);
    if (existing) {
      if (existing.archivedAt) {
        const restored = await storage.updateContact(existing.id, {
          displayName: input.displayName,
          organization: input.organization ?? null,
          category: input.category ?? "other",
          role: input.role ?? null,
          phone: input.phone ?? null,
          archivedAt: null,
        });
        return restored!;
      }
      throw new ContactConflictError("Local contact with this email already exists");
    }
    const data: InsertContact = {
      archidocUserId: null,
      email,
      displayName: input.displayName.trim(),
      organization: input.organization ?? null,
      category: input.category ?? "other",
      role: input.role ?? null,
      phone: input.phone ?? null,
      source: "local",
      archidocSourceUpdatedAt: null,
      lastUsedAt: null,
      archivedAt: null,
    };
    return storage.createContact(data);
  },

  async updateLocal(id: number, input: Partial<LocalContactInput>): Promise<Contact> {
    const existing = await storage.getContactById(id);
    if (!existing) throw new ContactNotFoundError();
    if (existing.source !== "local") {
      throw new ContactSourceMismatchError("Cannot edit archidoc-sourced contact via admin route");
    }
    const patch: Partial<Contact> = {};
    if (input.email !== undefined) patch.email = normalizeEmail(input.email);
    if (input.displayName !== undefined) patch.displayName = input.displayName.trim();
    if (input.organization !== undefined) patch.organization = input.organization ?? null;
    if (input.category !== undefined) patch.category = input.category;
    if (input.role !== undefined) patch.role = input.role ?? null;
    if (input.phone !== undefined) patch.phone = input.phone ?? null;
    const updated = await storage.updateContact(id, patch);
    return updated!;
  },

  async archiveLocal(id: number): Promise<Contact> {
    const existing = await storage.getContactById(id);
    if (!existing) throw new ContactNotFoundError();
    if (existing.source !== "local") {
      throw new ContactSourceMismatchError("Cannot archive archidoc-sourced contact via admin route");
    }
    return (await storage.archiveContact(id))!;
  },

  async upsertArchidoc(input: ArchidocContactInput): Promise<UpsertResult> {
    const email = normalizeOptionalEmail(input.email);
    const incomingTs = new Date(input.sourceUpdatedAt);
    if (!Number.isFinite(incomingTs.getTime())) {
      throw new ContactConflictError("Invalid sourceUpdatedAt");
    }
    const existing = await storage.getContactByArchidocUserId(input.archidocUserId);
    if (existing) {
      if (existing.source !== "archidoc") {
        throw new ContactSourceMismatchError("Existing contact is not archidoc-sourced");
      }
      const prevTs = existing.archidocSourceUpdatedAt;
      if (prevTs && prevTs.getTime() > incomingTs.getTime()) {
        return { applied: false, reason: "stale", contact: existing };
      }
      const updated = await storage.updateContact(existing.id, {
        email,
        displayName: input.displayName.trim(),
        organization: input.organization ?? null,
        category: input.category,
        role: input.role ?? null,
        phone: input.phone ?? null,
        archidocSourceUpdatedAt: incomingTs,
        archivedAt: null,
      });
      return { applied: true, contact: updated! };
    }
    const created = await storage.createContact({
      archidocUserId: input.archidocUserId,
      email,
      displayName: input.displayName.trim(),
      organization: input.organization ?? null,
      category: input.category,
      role: input.role ?? null,
      phone: input.phone ?? null,
      source: "archidoc",
      archidocSourceUpdatedAt: incomingTs,
      lastUsedAt: null,
      archivedAt: null,
    });
    return { applied: true, contact: created };
  },

  async archiveArchidoc(archidocUserId: string): Promise<{ archived: true; alreadyArchived: boolean }> {
    const existing = await storage.getContactByArchidocUserId(archidocUserId);
    if (!existing) return { archived: true, alreadyArchived: true };
    if (existing.source !== "archidoc") {
      throw new ContactSourceMismatchError("Existing contact is not archidoc-sourced");
    }
    if (existing.archivedAt) return { archived: true, alreadyArchived: true };
    await storage.archiveContact(existing.id);
    return { archived: true, alreadyArchived: false };
  },

  async bumpLastUsed(emails: string[]): Promise<void> {
    const seen = new Set<string>();
    for (const e of emails) {
      const n = normalizeEmail(e);
      if (seen.has(n)) continue;
      seen.add(n);
      await storage.bumpContactLastUsedByEmail(n);
    }
  },
};
