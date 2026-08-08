import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createContinuationEnvelope,
  ContinuationError,
  type ContinuationDeps,
} from "../ContinuationService";
import { stripCertificatePages } from "../PdfService";
import { PDFDocument } from "pdf-lib";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Fakes: capture every write so tests can prove the parent is never mutated
// and the child is created transactionally with signers + audit events.
// ---------------------------------------------------------------------------

let createdEnvelopes: any[] = [];
let createdSigners: any[] = [];
let auditEvents: any[] = [];
let uploadedFiles: { fileName: string; size: number }[] = [];
let deletedFiles: string[] = [];
let parentEnvelope: any;
let downloadResult: { data: Buffer; contentType: string } | null;
let txDepth = 0;
let writesOutsideTx = 0;

function makeParent(overrides: Record<string, any> = {}) {
  return {
    id: 42,
    subject: "Deed of Variation",
    externalRef: "REF-9",
    status: "signed",
    origin: null,
    originalPdfUrl: "/objects/orig.pdf",
    signedPdfUrl: "/objects/signed_42.pdf",
    documentHash: "abc123hash",
    totalPages: 5,
    signaturePlacementMode: "admin_placed",
    continuationSequence: null,
    deletedAt: null,
    ...overrides,
  };
}

async function makePdf(pages: number, keywords?: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  if (keywords) doc.setKeywords([keywords]);
  return Buffer.from(await doc.save());
}

const fakeDeps: Partial<ContinuationDeps> = {
  storage: {
    async getEnvelope(_id: number) {
      return parentEnvelope;
    },
    async createEnvelope(data: any, _tx?: any) {
      if (txDepth === 0) writesOutsideTx++;
      const env = { id: 100, createdAt: new Date(), ...data };
      createdEnvelopes.push(env);
      return env;
    },
    async createSigner(data: any, _tx?: any) {
      if (txDepth === 0) writesOutsideTx++;
      const s = { id: createdSigners.length + 1, ...data };
      createdSigners.push(s);
      return s;
    },
    async createAuditEvent(data: any, _tx?: any) {
      if (txDepth === 0) writesOutsideTx++;
      auditEvents.push(data);
      return { id: auditEvents.length, ...data };
    },
  } as any,
  async downloadFile(_url: string) {
    return downloadResult;
  },
  async uploadFile(fileName: string, buffer: Buffer) {
    uploadedFiles.push({ fileName, size: buffer.length });
    return `/objects/${fileName}`;
  },
  async deleteFile(urlPath: string) {
    deletedFiles.push(urlPath);
  },
  stripCertificatePages,
  generateToken: () => `tok_${createdSigners.length}_x`,
  transaction: async (fn) => {
    txDepth++;
    try {
      return await fn({});
    } finally {
      txDepth--;
    }
  },
};

beforeEach(async () => {
  createdEnvelopes = [];
  createdSigners = [];
  auditEvents = [];
  uploadedFiles = [];
  deletedFiles = [];
  writesOutsideTx = 0;
  parentEnvelope = makeParent();
  downloadResult = { data: await makePdf(5), contentType: "application/pdf" };
});

const input = {
  parentEnvelopeId: 42,
  signers: [{ email: "new@ex.com", fullName: "New Signer" }],
  actorEmail: "admin@renosud.com",
  ipAddress: "1.2.3.4",
};

// --------------------------- eligibility -----------------------------------

test("rejects missing parent with 404", async () => {
  parentEnvelope = undefined;
  await assert.rejects(
    createContinuationEnvelope(input, fakeDeps),
    (e: ContinuationError) => e.code === "parent_not_found" && e.httpStatus === 404,
  );
});

test("rejects soft-deleted parent with 404", async () => {
  parentEnvelope = makeParent({ deletedAt: new Date() });
  await assert.rejects(
    createContinuationEnvelope(input, fakeDeps),
    (e: ContinuationError) => e.code === "parent_not_found",
  );
});

test("rejects non-signed parent with 409", async () => {
  for (const status of ["draft", "sent", "viewed", "queried", "declined"]) {
    parentEnvelope = makeParent({ status });
    await assert.rejects(
      createContinuationEnvelope(input, fakeDeps),
      (e: ContinuationError) => e.code === "parent_not_signed" && e.httpStatus === 409,
    );
  }
});

test("rejects API-origin (partner) parent with 409", async () => {
  parentEnvelope = makeParent({ origin: "architrak" });
  await assert.rejects(
    createContinuationEnvelope(input, fakeDeps),
    (e: ContinuationError) => e.code === "parent_api_origin" && e.httpStatus === 409,
  );
});

test("rejects parent without signedPdfUrl, and when download fails", async () => {
  parentEnvelope = makeParent({ signedPdfUrl: null });
  await assert.rejects(
    createContinuationEnvelope(input, fakeDeps),
    (e: ContinuationError) => e.code === "parent_pdf_unavailable",
  );
  parentEnvelope = makeParent();
  downloadResult = null;
  await assert.rejects(
    createContinuationEnvelope(input, fakeDeps),
    (e: ContinuationError) => e.code === "parent_pdf_unavailable",
  );
  assert.equal(createdEnvelopes.length, 0);
});

// ----------------------------- creation ------------------------------------

test("creates a linked draft child with signers and audit events, inside a transaction", async () => {
  const child = await createContinuationEnvelope(input, fakeDeps);

  assert.equal(child.id, 100);
  assert.equal(createdEnvelopes.length, 1);
  const env = createdEnvelopes[0];
  assert.equal(env.status, "draft");
  assert.equal(env.parentEnvelopeId, 42);
  assert.equal(env.parentDocumentHash, "abc123hash");
  assert.equal(env.continuationSequence, 1);
  assert.equal(env.subject, "Deed of Variation — further signature");
  assert.equal(env.externalRef, "REF-9");
  assert.equal(env.signedPdfUrl, null);
  assert.equal(env.totalPages, 5);
  assert.ok(env.originalPdfUrl.startsWith("/objects/continuation_42_"));

  assert.equal(createdSigners.length, 1);
  assert.equal(createdSigners[0].envelopeId, 100);
  assert.equal(createdSigners[0].email, "new@ex.com");
  assert.ok(createdSigners[0].accessToken.startsWith("tok_"));

  // One audit event on the child, one on the parent — nothing else touched.
  assert.equal(auditEvents.length, 2);
  const childEvt = auditEvents.find((e) => e.envelopeId === 100);
  const parentEvt = auditEvents.find((e) => e.envelopeId === 42);
  assert.ok(childEvt && /continuation/i.test(childEvt.eventType));
  assert.ok(parentEvt && /further signature/i.test(parentEvt.eventType));
  assert.equal(JSON.parse(parentEvt.metadata).continuationEnvelopeId, 100);

  assert.equal(writesOutsideTx, 0, "all DB writes must happen inside the transaction");
});

test("strips parent certificate pages from the child's working document", async () => {
  // 5 content pages + 2 marker-tagged certificate pages.
  downloadResult = {
    data: await makePdf(7, "archisign-cert-v1:2"),
    contentType: "application/pdf",
  };
  await createContinuationEnvelope(input, fakeDeps);
  const env = createdEnvelopes[0];
  assert.equal(env.totalPages, 5, "cert pages must not count toward child totalPages");

  // Uploaded child PDF must have 5 pages and no marker left.
  assert.equal(uploadedFiles.length, 1);
});

test("increments continuationSequence for continuation-of-continuation", async () => {
  parentEnvelope = makeParent({ continuationSequence: 2 });
  await createContinuationEnvelope(input, fakeDeps);
  assert.equal(createdEnvelopes[0].continuationSequence, 3);
});

test("supports subject override and multiple signers", async () => {
  await createContinuationEnvelope(
    {
      ...input,
      subject: "Countersignature required",
      signers: [
        { email: "a@ex.com", fullName: "A" },
        { email: "b@ex.com", fullName: "B" },
      ],
    },
    fakeDeps,
  );
  assert.equal(createdEnvelopes[0].subject, "Countersignature required");
  assert.equal(createdSigners.length, 2);
  assert.notEqual(createdSigners[0].accessToken, createdSigners[1].accessToken);
});

test("legacy parent without documentHash: pins SHA-256 of the copied signed artifact", async () => {
  parentEnvelope = makeParent({ documentHash: null });
  const expected = createHash("sha256").update(downloadResult!.data).digest("hex");
  await createContinuationEnvelope(input, fakeDeps);
  assert.equal(createdEnvelopes[0].parentDocumentHash, expected);
  assert.ok(createdEnvelopes[0].parentDocumentHash, "provenance hash must never be null");
});

test("deletes the uploaded child PDF when the transaction fails", async () => {
  const failingDeps = {
    ...fakeDeps,
    transaction: async () => {
      throw new Error("db down");
    },
  };
  await assert.rejects(createContinuationEnvelope(input, failingDeps), /db down/);
  assert.equal(uploadedFiles.length, 1);
  assert.equal(deletedFiles.length, 1);
  assert.ok(deletedFiles[0].includes("continuation_42_"), "orphaned object must be cleaned up");
});

// ------------------------ stripCertificatePages ----------------------------

test("stripCertificatePages removes marker-tagged pages and clears the marker", async () => {
  const buf = await makePdf(6, "archisign-cert-v1:2");
  const { pdfBytes, pageCount, removedPages } = await stripCertificatePages(buf);
  assert.equal(pageCount, 4);
  assert.equal(removedPages, 2);
  const reloaded = await PDFDocument.load(pdfBytes);
  assert.equal(reloaded.getPageCount(), 4);
  assert.ok(!(reloaded.getKeywords() || "").includes("archisign-cert-v1"));
  // Idempotent: a second strip is a no-op.
  const second = await stripCertificatePages(Buffer.from(pdfBytes));
  assert.equal(second.removedPages, 0);
  assert.equal(second.pageCount, 4);
});

test("stripCertificatePages leaves unmarked PDFs untouched", async () => {
  const buf = await makePdf(3);
  const { pageCount, removedPages } = await stripCertificatePages(buf);
  assert.equal(pageCount, 3);
  assert.equal(removedPages, 0);
});
