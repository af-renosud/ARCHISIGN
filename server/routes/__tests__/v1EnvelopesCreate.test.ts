import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { storage } from "../../storage";
import { db } from "../../db";
import { ContactService } from "../../services/ContactService";
import { buildV1EnvelopesRouter } from "../v1Envelopes";

const ARCHIDOC_KEY = "archidoc-test-key";

let baseUrl = "";
let server: ReturnType<express.Application["listen"]>;

const PATCHED_STORAGE_KEYS = [
  "createEnvelope",
  "createSigner",
  "createAnnotation",
  "createAuditEvent",
] as const;

const originals: Record<string, any> = {};
let createdEnvelopes: any[] = [];
let createdAnnotations: any[] = [];

function installFakeStorage() {
  let envId = 0;
  let signerId = 0;
  const fake: any = {
    async createEnvelope(input: any) {
      envId += 1;
      const row = {
        id: envId,
        createdAt: new Date(),
        expiresAt: input.expiresAt ?? null,
        status: input.status ?? "draft",
        ...input,
      };
      createdEnvelopes.push(row);
      return row;
    },
    async createSigner(input: any) {
      signerId += 1;
      return { id: signerId, ...input };
    },
    async createAnnotation(input: any) {
      createdAnnotations.push(input);
      return { id: createdAnnotations.length, ...input };
    },
    async createAuditEvent(ev: any) { return ev; },
  };
  for (const k of PATCHED_STORAGE_KEYS) {
    originals[`storage.${k}`] = (storage as any)[k];
    (storage as any)[k] = fake[k].bind(fake);
  }
  // The create handler wraps writes in a db transaction; run the callback
  // directly with a throwaway executor (faked storage ignores it).
  originals["db.transaction"] = (db as any).transaction;
  (db as any).transaction = async (fn: any) => fn({});
  // bumpLastUsed touches the real DB; stub to a no-op for isolation.
  originals["ContactService.bumpLastUsed"] = ContactService.bumpLastUsed;
  (ContactService as any).bumpLastUsed = async () => {};
}

function restoreStorage() {
  for (const k of PATCHED_STORAGE_KEYS) (storage as any)[k] = originals[`storage.${k}`];
  (db as any).transaction = originals["db.transaction"];
  (ContactService as any).bumpLastUsed = originals["ContactService.bumpLastUsed"];
}

before(async () => {
  process.env.ARCHIDOC_API_KEY = ARCHIDOC_KEY;
  installFakeStorage();
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.use("/api/v1", buildV1EnvelopesRouter());
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

beforeEach(() => {
  createdEnvelopes = [];
  createdAnnotations = [];
});

async function create(body: any) {
  const res = await fetch(baseUrl + "/api/v1/envelopes/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": ARCHIDOC_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { status: res.status, body: json };
}

const baseRequest = {
  subject: "Plans for signature",
  signerEmail: "signer@example.com",
  signerName: "Signer One",
  pdfUrl: "https://example.com/doc.pdf",
};

test("v1 create: non-empty body persists trimmed message on the envelope", async () => {
  const r = await create({ ...baseRequest, body: "  Please review and sign.  " });
  assert.equal(r.status, 201);
  assert.equal(createdEnvelopes.length, 1);
  assert.equal(createdEnvelopes[0].message, "Please review and sign.");
});

test("v1 create: whitespace-only body persists message as null", async () => {
  const r = await create({ ...baseRequest, body: "   \n\t  " });
  assert.equal(r.status, 201);
  assert.equal(createdEnvelopes.length, 1);
  assert.equal(createdEnvelopes[0].message, null);
});

test("v1 create: omitted body persists message as null", async () => {
  const r = await create({ ...baseRequest });
  assert.equal(r.status, 201);
  assert.equal(createdEnvelopes.length, 1);
  assert.equal(createdEnvelopes[0].message, null);
});

// --- v1.4 §3.5.1.1(c): emailRendering echo ---

test("v1.4 echo: subject + body supplied -> both applied true", async () => {
  const r = await create({ ...baseRequest, body: "Please sign." });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.emailRendering, { subjectApplied: true, bodyApplied: true });
});

test("v1.4 echo: omitted subject and body -> both applied false", async () => {
  const { subject: _s, ...noSubject } = baseRequest;
  const r = await create({ ...noSubject });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.emailRendering, { subjectApplied: false, bodyApplied: false });
});

test("v1.4 echo: whitespace-only subject -> subjectApplied false, default subject stored", async () => {
  const r = await create({ ...baseRequest, subject: "   \t " });
  assert.equal(r.status, 201);
  assert.equal(r.body.emailRendering.subjectApplied, false);
  assert.equal(createdEnvelopes[0].subject, "Document for signature");
});

test("v1.4 echo: subject with surrounding spaces -> applied true, caller string stored verbatim", async () => {
  const r = await create({ ...baseRequest, subject: "  Devis — lot 3  " });
  assert.equal(r.status, 201);
  assert.equal(r.body.emailRendering.subjectApplied, true);
  assert.equal(createdEnvelopes[0].subject, "  Devis — lot 3  ");
});

test("v1.4 echo: whitespace-only body -> bodyApplied false", async () => {
  const r = await create({ ...baseRequest, body: "   \n  " });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.emailRendering, { subjectApplied: true, bodyApplied: false });
});

// --- v1.4 §3.5.1.1(b): body length cap in Unicode code points ---

test("v1.4 cap: body of exactly 2000 code points is accepted", async () => {
  const r = await create({ ...baseRequest, body: "a".repeat(2000) });
  assert.equal(r.status, 201);
  assert.equal(createdEnvelopes[0].message, "a".repeat(2000));
});

test("v1.4 cap: body of 2001 code points -> 400 body_too_long", async () => {
  const r = await create({ ...baseRequest, body: "a".repeat(2001) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "body_too_long");
  assert.equal(createdEnvelopes.length, 0);
});

test("v1.4 cap: astral emoji counts as one code point, not two UTF-16 units", async () => {
  // 2000 x U+1F600 = 4000 UTF-16 units but exactly 2000 code points -> accepted.
  const body = "\u{1F600}".repeat(2000);
  const r = await create({ ...baseRequest, body });
  assert.equal(r.status, 201);
  assert.equal(createdEnvelopes[0].message, body);
});

test("v1.4 cap: 2001 astral code points -> rejected", async () => {
  const r = await create({ ...baseRequest, body: "\u{1F600}".repeat(2001) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "body_too_long");
});

// --- v1.6 §3.5.1.3: autoPlaceInitials ---

test("v1.6 initials: pdfUrl source -> per-signer initials_source_unsupported warning, no boxes", async () => {
  const r = await create({
    ...baseRequest,
    signers: [
      { email: "a@example.com", fullName: "A" },
      { email: "b@example.com", fullName: "B" },
    ],
    signerEmail: undefined,
    signerName: undefined,
    autoPlaceInitials: true,
  });
  assert.equal(r.status, 201);
  const warns = (r.body.warnings || []).filter((w: any) => w.code === "initials_source_unsupported");
  assert.equal(warns.length, 2);
  assert.deepEqual(warns.map((w: any) => w.signerEmail).sort(), ["a@example.com", "b@example.com"]);
  assert.equal(createdAnnotations.length, 0);
});

test("v1.6 initials: flag absent -> no warnings, no annotations", async () => {
  const r = await create({ ...baseRequest });
  assert.equal(r.status, 201);
  assert.equal(r.body.warnings, undefined);
  assert.equal(createdAnnotations.length, 0);
});

test("v1.6 initials: pdfBase64 source -> one initial box per signer per page", async () => {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  doc.addPage([595.28, 841.89]);
  doc.addPage([595.28, 841.89]);
  const pdfBase64 = Buffer.from(await doc.save()).toString("base64");

  const r = await create({
    subject: "Initials test",
    pdfBase64,
    signers: [
      { email: "a@example.com", fullName: "A" },
      { email: "b@example.com", fullName: "B" },
    ],
    autoPlaceInitials: true,
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.warnings, undefined);
  const initials = createdAnnotations.filter((a) => a.type === "initial");
  assert.equal(initials.length, 6);
  for (const a of initials) {
    assert.equal(a.placed, true);
    assert.ok(a.pageNumber >= 1 && a.pageNumber <= 3);
    assert.ok(a.xPos >= 0 && a.xPos <= 1 && a.yPos >= 0 && a.yPos <= 1);
  }
  // Last-page boxes sit higher (smaller bottom-left distance from top => yPos smaller).
  const lastPage = initials.filter((a) => a.pageNumber === 3);
  const firstPage = initials.filter((a) => a.pageNumber === 1);
  assert.ok(lastPage[0].yPos < firstPage[0].yPos);
});

// --- missing client IP: creation must not fail, audit stores null ---

test("v1 create: undefined req.ip does not fail creation; audit ipAddress is null", async () => {
  const auditEvents: any[] = [];
  const prevAudit = (storage as any).createAuditEvent;
  (storage as any).createAuditEvent = async (ev: any) => { auditEvents.push(ev); return ev; };
  const app2 = express();
  app2.use(express.json({ limit: "25mb" }));
  // Simulate a runtime where no client IP is resolvable (e.g. proxy quirk).
  app2.use((req, _res, next) => {
    Object.defineProperty(req, "ip", { get: () => undefined });
    next();
  });
  app2.use("/api/v1", buildV1EnvelopesRouter());
  const srv = app2.listen(0);
  const addr = srv.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/v1/envelopes/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": ARCHIDOC_KEY },
      body: JSON.stringify(baseRequest),
    });
    assert.equal(res.status, 201);
    assert.ok(auditEvents.length > 0);
    for (const ev of auditEvents) assert.equal(ev.ipAddress, null);
  } finally {
    (storage as any).createAuditEvent = prevAudit;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});
