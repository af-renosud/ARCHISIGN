import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { storage } from "../../storage";
import { buildV1ContactsRouter } from "../v1Contacts";

const ARCHIDOC_KEY = "archidoc-test-key";
const ARCHITRAK_KEY = "architrak-test-key";

let baseUrl = "";
let server: ReturnType<express.Application["listen"]>;

const PATCHED_KEYS = [
  "getContactById",
  "getContactByArchidocUserId",
  "getContactBySourceEmail",
  "createContact",
  "updateContact",
  "archiveContact",
  "bumpContactLastUsedByEmail",
  "createAuditEvent",
  "getBulkDedupRow",
  "recordBulkDedupRow",
] as const;

const originals: Record<string, any> = {};
let auditCalls: any[] = [];

function installFakeStorage() {
  let id = 0;
  const rows = new Map<number, any>();
  const fake: any = {
    async getContactById(i: number) { return rows.get(i) ?? null; },
    async getContactByArchidocUserId(uid: string) {
      for (const r of rows.values()) if (r.archidocUserId === uid) return r;
      return null;
    },
    async getContactBySourceEmail(_s: string, _e: string) { return null; },
    async createContact(input: any) {
      id += 1;
      const row = {
        id, createdAt: new Date(), updatedAt: new Date(),
        archidocUserId: null, organization: null, role: null, phone: null,
        archidocSourceUpdatedAt: null, lastUsedAt: null, archivedAt: null,
        ...input,
      };
      rows.set(id, row); return row;
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
    async bumpContactLastUsedByEmail(_e: string) {},
    async createAuditEvent(ev: any) { auditCalls.push(ev); return ev; },
    _dedup: new Map<string, any>(),
    async getBulkDedupRow(tenant: string, batchId: string, archidocUserId: string) {
      return fake._dedup.get(`${tenant}::${batchId}::${archidocUserId}`) || undefined;
    },
    async recordBulkDedupRow(row: any) {
      const k = `${row.tenant}::${row.batchId}::${row.archidocUserId}`;
      if (!fake._dedup.has(k)) fake._dedup.set(k, row);
    },
  };
  for (const k of PATCHED_KEYS) {
    originals[k] = (storage as any)[k];
    (storage as any)[k] = fake[k].bind(fake);
  }
}

function restoreStorage() {
  for (const k of PATCHED_KEYS) (storage as any)[k] = originals[k];
}

before(async () => {
  process.env.ARCHIDOC_API_KEY = ARCHIDOC_KEY;
  process.env.ARCHITRAK_API_KEY = ARCHITRAK_KEY;
  installFakeStorage();
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.use("/api/v1", buildV1ContactsRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  restoreStorage();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(method: string, path: string, body: any, key: string | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["X-API-KEY"] = key;
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { status: res.status, body: json, raw: text };
}

test("v1 contacts: rejects unknown api key", async () => {
  const r = await call("PUT", "/api/v1/contacts/archidoc/u1", {
    email: "a@b.com", displayName: "A", category: "client", sourceUpdatedAt: "2026-05-11T10:00:00Z",
  }, "garbage");
  assert.equal(r.status, 401);
});

test("v1 contacts: archidoc tenant required (architrak forbidden)", async () => {
  const r = await call("PUT", "/api/v1/contacts/archidoc/u2", {
    email: "x@y.com", displayName: "X", category: "client", sourceUpdatedAt: "2026-05-11T10:00:00Z",
  }, ARCHITRAK_KEY);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "tenant_forbidden");
});

test("v1 contacts: PUT upsert applies and audits contact.synced", async () => {
  auditCalls = [];
  const r = await call("PUT", "/api/v1/contacts/archidoc/u-apply", {
    email: "p@q.com", displayName: "P", category: "client", sourceUpdatedAt: "2026-05-11T10:00:00Z",
  }, ARCHIDOC_KEY);
  assert.equal(r.status, 200);
  assert.equal(r.body.applied, true);
  assert.equal(r.body.contact.email, "p@q.com");
  assert.ok(auditCalls.find((a) => a.eventType === "contact.synced" && a.envelopeId === null));
});

test("v1 contacts: stale write returns applied:false reason:stale", async () => {
  await call("PUT", "/api/v1/contacts/archidoc/u-stale", {
    email: "s@t.com", displayName: "S v1", category: "client", sourceUpdatedAt: "2026-05-10T10:00:00Z",
  }, ARCHIDOC_KEY);
  const r = await call("PUT", "/api/v1/contacts/archidoc/u-stale", {
    email: "s@t.com", displayName: "S v0", category: "client", sourceUpdatedAt: "2026-01-01T00:00:00Z",
  }, ARCHIDOC_KEY);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { applied: false, reason: "stale" });
});

test("v1 contacts: DELETE unknown id is idempotent (alreadyArchived:true)", async () => {
  const r = await call("DELETE", "/api/v1/contacts/archidoc/never-existed", undefined, ARCHIDOC_KEY);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { archived: true, alreadyArchived: true });
});

test("v1 contacts: bulk 200 with mixed accepted/rejected (per-row partial success)", async () => {
  await call("PUT", "/api/v1/contacts/archidoc/u-bulk-stale", {
    email: "b@c.com", displayName: "B", category: "client", sourceUpdatedAt: "2026-05-11T10:00:00Z",
  }, ARCHIDOC_KEY);
  auditCalls = [];
  const r = await call("POST", "/api/v1/contacts/archidoc/bulk", {
    contacts: [
      { id: "u-bulk-new", email: "n@e.com", displayName: "N", category: "partner", sourceUpdatedAt: "2026-05-11T10:00:00Z" },
      { id: "u-bulk-stale", email: "b@c.com", displayName: "B old", category: "client", sourceUpdatedAt: "2026-01-01T00:00:00Z" },
    ],
  }, ARCHIDOC_KEY);
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted.length, 2);
  assert.equal(r.body.rejected.length, 0);
  const stale = r.body.accepted.find((a: any) => a.id === "u-bulk-stale");
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "stale");
  assert.ok(auditCalls.find((a) => a.eventType === "contact.bulk_imported"));
});

test("v1 contacts: bulk returns per-row partial success when one row is malformed", async () => {
  const r = await call("POST", "/api/v1/contacts/archidoc/bulk", {
    contacts: [
      { id: "row-good", email: "g@h.com", displayName: "G", category: "client", sourceUpdatedAt: "2026-05-11T10:00:00Z" },
      { id: "row-bad", email: "not-an-email", displayName: "X", category: "client", sourceUpdatedAt: "2026-05-11T10:00:00Z" },
    ],
  }, ARCHIDOC_KEY);
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted.length, 1);
  assert.equal(r.body.accepted[0].id, "row-good");
  assert.equal(r.body.rejected.length, 1);
  assert.equal(r.body.rejected[0].id, "row-bad");
});

test("v1 contacts: rate-limit family contacts returns 429 after burst", async () => {
  const { _resetBucketsForTest } = await import("../../middleware/rateLimit");
  _resetBucketsForTest();
  const validBody = { email: "rl@x.com", displayName: "RL", category: "client", sourceUpdatedAt: "2026-05-11T10:00:00Z" };
  let saw429 = false;
  let last: any = null;
  for (let i = 0; i < 35; i++) {
    last = await call("PUT", `/api/v1/contacts/archidoc/rl-${i}`, validBody, ARCHIDOC_KEY);
    if (last.status === 429) { saw429 = true; break; }
  }
  assert.ok(saw429, `expected a 429 in burst window; last status=${last?.status}`);
  assert.equal(last.body.error, "rate_limit_exceeded");
  assert.ok(last.body.retryAfter >= 1);
  _resetBucketsForTest();
});

test("v1.3.1: PUT accepts email:null (system-actor with no email)", async () => {
  const r = await call("PUT", "/api/v1/contacts/archidoc/sa-noemail", {
    id: "sa-noemail", email: null, displayName: "No Email Actor",
    category: "partner", role: "MOA", sourceUpdatedAt: "2026-05-11T10:00:00Z",
  }, ARCHIDOC_KEY);
  assert.equal(r.status, 200);
  assert.equal(r.body.applied, true);
  assert.equal(r.body.contact.email, null);
});

test("v1.3.1: PUT rejects body.id ≠ URL :id with 400 id_mismatch", async () => {
  const r = await call("PUT", "/api/v1/contacts/archidoc/url-id", {
    id: "different-id", email: "x@y.com", displayName: "X",
    category: "client", sourceUpdatedAt: "2026-05-11T10:00:00Z",
  }, ARCHIDOC_KEY);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "id_mismatch");
});

test("v1.3.1: bulk accepts `rows` (ArchiDoc shape) and per-row email:null", async () => {
  const r = await call("POST", "/api/v1/contacts/archidoc/bulk", {
    batchId: "v131-rows-1",
    rows: [
      { id: "r1", email: null, displayName: "R1", category: "contractor", sourceUpdatedAt: "2026-05-11T10:00:00Z" },
      { id: "r2", email: "r2@x.com", displayName: "R2", category: "client", sourceUpdatedAt: "2026-05-11T10:00:00Z" },
    ],
  }, ARCHIDOC_KEY);
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted.length, 2);
  assert.equal(r.body.batchId, "v131-rows-1");
});

test("v1.3.1: bulk dedup on (batchId, id) returns prior outcome on re-run", async () => {
  const body = {
    batchId: "v131-dedup-1",
    rows: [{ id: "dd1", email: "d@d.com", displayName: "D", category: "client", sourceUpdatedAt: "2026-05-11T10:00:00Z" }],
  };
  const r1 = await call("POST", "/api/v1/contacts/archidoc/bulk", body, ARCHIDOC_KEY);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.accepted[0].applied, true);
  assert.ok(!r1.body.accepted[0].deduplicated);
  const r2 = await call("POST", "/api/v1/contacts/archidoc/bulk", body, ARCHIDOC_KEY);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.accepted[0].deduplicated, true);
  assert.equal(r2.body.accepted[0].applied, true);
});

test("v1.3.1: bulk via X-Batch-Id header (no body batchId) also dedups", async () => {
  const headers = { "X-Batch-Id": "v131-hdr-1" };
  const body = { rows: [{ id: "hdr1", email: "h@h.com", displayName: "H", category: "partner", sourceUpdatedAt: "2026-05-11T10:00:00Z" }] };
  const post = async () => fetch(baseUrl + "/api/v1/contacts/archidoc/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": ARCHIDOC_KEY, ...headers },
    body: JSON.stringify(body),
  });
  const a = await (await post()).json();
  const b = await (await post()).json();
  assert.equal(a.accepted[0].deduplicated ?? false, false);
  assert.equal(b.accepted[0].deduplicated, true);
});

test("v1.3.1: header/body batchId mismatch returns 400 batch_id_mismatch", async () => {
  const r = await fetch(baseUrl + "/api/v1/contacts/archidoc/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": ARCHIDOC_KEY, "X-Batch-Id": "hdr-A" },
    body: JSON.stringify({ batchId: "body-B", rows: [{ id: "x", email: "x@y.com", displayName: "X", category: "client", sourceUpdatedAt: "2026-05-11T10:00:00Z" }] }),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error, "batch_id_mismatch");
});

test("v1 contacts: bulk over 500 rows returns 413 payload_too_large", async () => {
  const contacts = Array.from({ length: 501 }, (_, i) => ({
    id: `over-${i}`, email: `o${i}@x.com`, displayName: `O${i}`,
    category: "other", sourceUpdatedAt: "2026-05-11T10:00:00Z",
  }));
  const r = await call("POST", "/api/v1/contacts/archidoc/bulk", { contacts }, ARCHIDOC_KEY);
  assert.equal(r.status, 413);
  assert.equal(r.body.error, "payload_too_large");
});
