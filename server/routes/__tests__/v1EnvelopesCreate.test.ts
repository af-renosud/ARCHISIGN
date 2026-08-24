import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { storage } from "../../storage";
import { db } from "../../db";
import { ContactService } from "../../services/ContactService";
import { buildV1EnvelopesRouter } from "../v1Envelopes";

const ARCHIDOC_KEY = "archidoc-test-key";
const ARCHITRAK_KEY = "architrak-test-key";

let baseUrl = "";
let server: ReturnType<express.Application["listen"]>;

const PATCHED_STORAGE_KEYS = [
  "createEnvelope",
  "createSigner",
  "createAnnotation",
  "createAuditEvent",
  "getEnvelope",
  "atomicClaimEnvelopeSend",
] as const;

const originals: Record<string, any> = {};
let createdEnvelopes: any[] = [];
let createdAnnotations: any[] = [];
let apiSendClaims = 0;

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
    async getEnvelope(id: number) {
      const envelope = createdEnvelopes.find((row) => row.id === id);
      return envelope
        ? { ...envelope, signers: [], communicationLogs: [], auditEvents: [] }
        : undefined;
    },
    async atomicClaimEnvelopeSend(id: number, at: Date) {
      const index = createdEnvelopes.findIndex((row) => row.id === id && row.status === "draft");
      if (index === -1) return null;
      apiSendClaims += 1;
      createdEnvelopes[index] = { ...createdEnvelopes[index], status: "sent", updatedAt: at };
      return createdEnvelopes[index];
    },
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
  process.env.ARCHITRAK_API_KEY = ARCHITRAK_KEY;
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
  apiSendClaims = 0;
});

async function create(body: any, key = ARCHIDOC_KEY) {
  const res = await fetch(baseUrl + "/api/v1/envelopes/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": key },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { status: res.status, body: json };
}

async function send(envelopeId: number, key = ARCHIDOC_KEY) {
  const res = await fetch(`${baseUrl}/api/v1/envelopes/${envelopeId}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": key },
    body: "{}",
  });
  return { status: res.status, body: await res.json() };
}

async function pdfWithAnchors(anchors: Array<{ text: string; x: number; y: number; opacity?: number }>) {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const anchor of anchors) {
    page.drawText(anchor.text, {
      x: anchor.x,
      y: anchor.y,
      size: 10,
      font,
      opacity: anchor.opacity ?? 0,
    });
  }
  return Buffer.from(await doc.save()).toString("base64");
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

test("ArchiDoc create: one unique anchor per signer is high-confidence and ready to send", async () => {
  const pdfBase64 = await pdfWithAnchors([
    { text: "{{ASIG:CLIENT:1}}", x: 72, y: 180 },
    { text: "{{ASIG:CONTRACTOR:1}}", x: 320, y: 180 },
  ]);
  const r = await create({
    subject: "Anchored contract",
    pdfBase64,
    signers: [
      {
        email: "client@example.com",
        fullName: "Client Signatory",
        anchor: "{{ASIG:CLIENT:1}}",
        anchorOffset: { x: 0, y: 2 },
        size: { width: 180, height: 84 },
      },
      {
        email: "contractor@example.com",
        fullName: "Contractor Signatory",
        anchor: "{{ASIG:CONTRACTOR:1}}",
        anchorOffset: { x: 0, y: 2 },
        size: { width: 180, height: 84 },
      },
    ],
  });

  assert.equal(r.status, 201);
  assert.deepEqual(r.body.placementReview, {
    state: "ready",
    confidence: "high",
    reasons: [
      {
        code: "signer_specific_anchors_resolved",
        message: "2 signer-specific anchors resolved exactly once.",
      },
      {
        code: "placement_geometry_valid",
        message: "Every automatic signature box fits inside its PDF page without adjustment or overlap.",
      },
    ],
    automaticSendAllowed: true,
  });
  assert.equal(createdEnvelopes[0].placementReviewState, "ready");
  assert.equal(createdEnvelopes[0].placementConfidence, "high");
  assert.equal(createdAnnotations.filter((annotation) => annotation.type === "signature").length, 2);
});

test("ArchiDoc create: missing signer anchor requires review and API send is blocked", async () => {
  const pdfBase64 = await pdfWithAnchors([
    { text: "{{ASIG:CLIENT:1}}", x: 72, y: 180 },
  ]);
  const created = await create({
    subject: "Ambiguous contract",
    pdfBase64,
    signers: [
      {
        email: "client@example.com",
        fullName: "Client Signatory",
        anchor: "{{ASIG:CLIENT:1}}",
        size: { width: 180, height: 84 },
      },
      {
        email: "contractor@example.com",
        fullName: "Contractor Signatory",
      },
    ],
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.placementReview.state, "review_required");
  assert.equal(created.body.placementReview.confidence, "low");
  assert.equal(created.body.placementReview.automaticSendAllowed, false);
  assert.ok(created.body.placementReview.reasons.some((reason: any) =>
    ["signer_anchor_missing", "signer_name_not_found"].includes(reason.code)));

  const sent = await send(created.body.envelopeId);
  assert.equal(sent.status, 409);
  assert.equal(sent.body.error, "placement_review_required");
  assert.equal(apiSendClaims, 0);
});

test("ArchiDoc create: strict printed-name and Signature-caption evidence can place fields without anchors", async () => {
  const pdfBase64 = await pdfWithAnchors([
    { text: "Client Signatory", x: 72, y: 260, opacity: 1 },
    { text: "Signature", x: 72, y: 180, opacity: 1 },
    { text: "Contractor Signatory", x: 352, y: 260, opacity: 1 },
    { text: "Signature", x: 352, y: 180, opacity: 1 },
  ]);
  const r = await create({
    subject: "Digitally generated contract",
    pdfBase64,
    signers: [
      { email: "client@example.com", fullName: "Client Signatory" },
      { email: "contractor@example.com", fullName: "Contractor Signatory" },
    ],
  });

  assert.equal(r.status, 201);
  assert.equal(r.body.placementReview.state, "ready");
  assert.equal(r.body.placementReview.confidence, "high");
  assert.ok(r.body.placementReview.reasons.some((reason: any) => reason.code === "signer_name_and_caption_resolved"));
  assert.equal(createdEnvelopes[0].signaturePlacementMode, "admin_placed");
  assert.equal(createdAnnotations.filter((annotation) => annotation.type === "signature").length, 2);
});

test("ArchiDoc create: a reused signer anchor is ambiguous and requires review", async () => {
  const pdfBase64 = await pdfWithAnchors([
    { text: "{{ASIG:SHARED:1}}", x: 72, y: 180 },
  ]);
  const r = await create({
    subject: "Reused anchor",
    pdfBase64,
    signers: [
      { email: "client@example.com", fullName: "Client Signatory", anchor: "{{ASIG:SHARED:1}}" },
      { email: "contractor@example.com", fullName: "Contractor Signatory", anchor: "{{ASIG:SHARED:1}}" },
    ],
  });

  assert.equal(r.status, 201);
  assert.equal(r.body.placementReview.state, "review_required");
  assert.ok(r.body.placementReview.reasons.some((reason: any) => reason.code === "signer_anchor_reused"));
  assert.ok(r.body.placementReview.reasons.some((reason: any) => reason.code === "signature_fields_overlap"));
});

test("ArchiDoc layout inference rejects a signer name that only appears inside a longer line", async () => {
  const pdfBase64 = await pdfWithAnchors([
    { text: "Client Signatory Limited", x: 72, y: 260, opacity: 1 },
    { text: "Signature", x: 72, y: 180, opacity: 1 },
  ]);
  const r = await create({
    subject: "Inexact signer identity",
    pdfBase64,
    signers: [{ email: "client@example.com", fullName: "Client Signatory" }],
  });

  assert.equal(r.status, 201);
  assert.equal(r.body.placementReview.state, "review_required");
  assert.ok(r.body.placementReview.reasons.some((reason: any) => reason.code === "signer_name_not_found"));
});

test("ArchiDoc layout inference rejects even a narrow overlap between signer fields", async () => {
  const pdfBase64 = await pdfWithAnchors([
    { text: "Client Signatory", x: 72, y: 260, opacity: 1 },
    { text: "Signature", x: 72, y: 180, opacity: 1 },
    { text: "Contractor Signatory", x: 290, y: 260, opacity: 1 },
    { text: "Signature", x: 290, y: 180, opacity: 1 },
  ]);
  const r = await create({
    subject: "Narrow overlap",
    pdfBase64,
    signers: [
      { email: "client@example.com", fullName: "Client Signatory" },
      { email: "contractor@example.com", fullName: "Contractor Signatory" },
    ],
  });

  assert.equal(r.status, 201);
  assert.equal(r.body.placementReview.state, "review_required");
  assert.ok(r.body.placementReview.reasons.some((reason: any) => reason.code === "signature_fields_overlap"));
});

test("ArchiDoc layout inference rejects a box that must be clamped to the page", async () => {
  const pdfBase64 = await pdfWithAnchors([
    { text: "Edge Signer", x: 520, y: 260, opacity: 1 },
    { text: "Signature", x: 520, y: 180, opacity: 1 },
  ]);
  const r = await create({
    subject: "Edge placement",
    pdfBase64,
    signers: [{ email: "edge@example.com", fullName: "Edge Signer" }],
  });

  assert.equal(r.status, 201);
  assert.equal(r.body.placementReview.state, "review_required");
  assert.ok(r.body.placementReview.reasons.some((reason: any) => reason.code === "layout_box_clamped"));
});

test("ArchiDoc layout inference rejects duplicate unanchored signer identities", async () => {
  const pdfBase64 = await pdfWithAnchors([
    { text: "Alex Smith", x: 72, y: 260, opacity: 1 },
    { text: "Signature", x: 72, y: 180, opacity: 1 },
    { text: "Signature", x: 352, y: 180, opacity: 1 },
  ]);
  const r = await create({
    subject: "Duplicate signer names",
    pdfBase64,
    signers: [
      { email: "alex.one@example.com", fullName: "Alex Smith" },
      { email: "alex.two@example.com", fullName: "Alex Smith" },
    ],
  });

  assert.equal(r.status, 201);
  assert.equal(r.body.placementReview.state, "review_required");
  assert.equal(r.body.placementReview.automaticSendAllowed, false);
  assert.ok(r.body.placementReview.reasons.some((reason: any) => reason.code === "duplicate_signer_identity"));

  const sent = await send(r.body.envelopeId);
  assert.equal(sent.status, 409);
  assert.equal(sent.body.error, "placement_review_required");
});

test("ArchiTrak create remains outside the Archie Doc placement-review policy", async () => {
  const r = await create({
    ...baseRequest,
  }, ARCHITRAK_KEY);
  assert.equal(r.status, 201);
  assert.equal(r.body.placementReview, undefined);
  assert.equal(createdEnvelopes[0].placementReviewState, "not_required");
  assert.equal(createdEnvelopes[0].origin, "architrak");
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
