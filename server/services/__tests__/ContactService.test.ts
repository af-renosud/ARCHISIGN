import { test } from "node:test";
import assert from "node:assert/strict";
import type { Contact } from "@shared/schema";
import { ContactService, ContactConflictError, ContactSourceMismatchError } from "../ContactService";
import { storage } from "../../storage";

type ContactRow = Contact & Record<string, any>;

function makeFakeStorage() {
  let id = 0;
  const rows = new Map<number, ContactRow>();
  const fake = {
    async getContactById(i: number) { return rows.get(i) ?? null; },
    async getContactByArchidocUserId(uid: string) {
      for (const r of rows.values()) if (r.archidocUserId === uid) return r;
      return null;
    },
    async getContactBySourceEmail(source: "local" | "archidoc", email: string) {
      for (const r of rows.values()) if (r.source === source && r.email === email) return r;
      return null;
    },
    async createContact(input: any) {
      id += 1;
      const row: ContactRow = {
        id, createdAt: new Date(), updatedAt: new Date(),
        archidocUserId: null, organization: null, role: null, phone: null,
        archidocSourceUpdatedAt: null, lastUsedAt: null, archivedAt: null,
        ...input,
      };
      rows.set(id, row);
      return row;
    },
    async updateContact(i: number, patch: any) {
      const r = rows.get(i); if (!r) return null;
      const next = { ...r, ...patch, updatedAt: new Date() };
      rows.set(i, next); return next;
    },
    async archiveContact(i: number) {
      const r = rows.get(i); if (!r) return null;
      const next = { ...r, archivedAt: new Date() };
      rows.set(i, next); return next;
    },
    async bumpContactLastUsedByEmail(_email: string) { /* noop */ },
    async searchContacts() { return Array.from(rows.values()); },
  };
  return { fake, rows };
}

const PATCHED_KEYS = [
  "getContactById",
  "getContactByArchidocUserId",
  "getContactBySourceEmail",
  "createContact",
  "updateContact",
  "archiveContact",
  "bumpContactLastUsedByEmail",
  "searchContacts",
] as const;

function withFakeStorage(fn: () => Promise<void>): Promise<void> {
  const { fake } = makeFakeStorage();
  const originals: Record<string, any> = {};
  for (const k of PATCHED_KEYS) {
    originals[k] = (storage as any)[k];
    (storage as any)[k] = (fake as any)[k].bind(fake);
  }
  return fn().finally(() => {
    for (const k of PATCHED_KEYS) (storage as any)[k] = originals[k];
  });
}

test("createLocal: rejects duplicate active local email", async () => {
  await withFakeStorage(async () => {
    await ContactService.createLocal({ email: "Foo@Example.com", displayName: "Foo" });
    await assert.rejects(
      ContactService.createLocal({ email: "foo@example.com", displayName: "Foo2" }),
      ContactConflictError,
    );
  });
});

test("createLocal: restores a previously archived local row", async () => {
  await withFakeStorage(async () => {
    const c = await ContactService.createLocal({ email: "x@y.com", displayName: "X" });
    await ContactService.archiveLocal(c.id);
    const restored = await ContactService.createLocal({ email: "x@y.com", displayName: "X v2", category: "client" });
    assert.equal(restored.id, c.id);
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.displayName, "X v2");
  });
});

test("upsertArchidoc: stale write returns applied:false without mutation", async () => {
  await withFakeStorage(async () => {
    const first = await ContactService.upsertArchidoc({
      archidocUserId: "u-1", email: "a@b.com", displayName: "A v1",
      category: "client", sourceUpdatedAt: "2026-05-10T10:00:00Z",
    });
    assert.equal(first.applied, true);
    const stale = await ContactService.upsertArchidoc({
      archidocUserId: "u-1", email: "a@b.com", displayName: "A v0",
      category: "client", sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.reason, "stale");
    assert.equal(stale.contact.displayName, "A v1");
  });
});

test("upsertArchidoc: newer write applies and updates fields", async () => {
  await withFakeStorage(async () => {
    await ContactService.upsertArchidoc({
      archidocUserId: "u-2", email: "x@y.com", displayName: "Old",
      category: "client", sourceUpdatedAt: "2026-05-10T10:00:00Z",
    });
    const next = await ContactService.upsertArchidoc({
      archidocUserId: "u-2", email: "X@Y.com", displayName: "New",
      category: "partner", sourceUpdatedAt: "2026-05-11T10:00:00Z",
    });
    assert.equal(next.applied, true);
    assert.equal(next.contact.displayName, "New");
    assert.equal(next.contact.category, "partner");
    assert.equal(next.contact.email, "x@y.com");
  });
});

test("archiveArchidoc: unknown id is idempotent", async () => {
  await withFakeStorage(async () => {
    const r = await ContactService.archiveArchidoc("never-existed");
    assert.deepEqual(r, { archived: true, alreadyArchived: true });
  });
});

test("archiveArchidoc: archives a known row, reports re-archive as alreadyArchived", async () => {
  await withFakeStorage(async () => {
    await ContactService.upsertArchidoc({
      archidocUserId: "u-3", email: "z@y.com", displayName: "Z",
      category: "client", sourceUpdatedAt: "2026-05-10T10:00:00Z",
    });
    const r1 = await ContactService.archiveArchidoc("u-3");
    assert.deepEqual(r1, { archived: true, alreadyArchived: false });
    const r2 = await ContactService.archiveArchidoc("u-3");
    assert.deepEqual(r2, { archived: true, alreadyArchived: true });
  });
});

test("updateLocal: refuses to mutate an archidoc-sourced row", async () => {
  await withFakeStorage(async () => {
    const r = await ContactService.upsertArchidoc({
      archidocUserId: "u-4", email: "p@q.com", displayName: "P",
      category: "client", sourceUpdatedAt: "2026-05-10T10:00:00Z",
    });
    await assert.rejects(
      ContactService.updateLocal(r.contact.id, { displayName: "hacked" }),
      ContactSourceMismatchError,
    );
  });
});
