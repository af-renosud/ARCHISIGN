import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { PDFDocument } from "pdf-lib";
import { stampSignedPdf, getPageCount, type EnvelopeCertificateContext } from "../PdfService";

async function makeBlankPdf(pages = 2): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    doc.addPage([595.28, 841.89]);
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

async function extractPageText(buf: Buffer, pageIndex: number): Promise<string> {
  // Best-effort raw-bytes scan: pdf-lib doesn't extract text, but pdf-lib's
  // saved output writes literal strings in parens for our drawText calls.
  // For assertion we scan the raw PDF bytes for the literal substring.
  return buf.toString("latin1");
}

function makeContext(envelopeId: number): EnvelopeCertificateContext {
  const now = new Date("2026-05-25T11:54:29Z");
  return {
    envelopeId,
    subject: "Test Envelope Subject",
    externalRef: "EXT-123",
    status: "Completed",
    origin: "archidoc",
    firmName: "Test Firm",
    firmEmail: "firm@test.example",
    totalDocumentPages: 2,
    signatureCount: 1,
    initialCount: 1,
    envelopeCreatedAt: new Date("2026-05-20T09:00:00Z"),
    signers: [
      {
        id: 42,
        fullName: "Spencer Livermore",
        email: "spencer.livermore@example.com",
        signedAt: now,
        sentAt: new Date("2026-05-20T10:00:00Z"),
        lastViewedAt: new Date("2026-05-25T11:52:58Z"),
        otpIssuedAt: new Date("2026-05-25T11:50:00Z"),
        otpVerifiedAt: new Date("2026-05-25T11:51:00Z"),
        signerIpAddress: "51.191.67.211",
        signerUserAgent: "Mozilla/5.0 Test",
      },
    ],
    auditEvents: [
      { eventType: "Envelope Sent", actorEmail: "admin@firm", timestamp: new Date("2026-05-20T10:00:00Z") },
      { eventType: "Document signed", actorEmail: "spencer.livermore@example.com", timestamp: now },
    ],
  };
}

test("stampSignedPdf appends a certificate page when context is provided", async () => {
  const input = await makeBlankPdf(2);
  const baselinePages = await getPageCount(input);
  assert.equal(baselinePages, 2);

  const ctx = makeContext(101);
  const { signedPdfBytes, documentHash } = await stampSignedPdf(input, [], 101, "fixed_bottom_centre", ctx);

  const outBuf = Buffer.from(signedPdfBytes);
  const finalPages = await getPageCount(outBuf);
  assert.ok(finalPages > baselinePages, `expected more pages, got ${finalPages}`);
  assert.match(documentHash, /^[0-9a-f]{64}$/);

  // pdf-lib compresses page content streams, so we can't reliably grep the
  // raw bytes for drawn text. Instead, verify the metadata marker we wrote
  // alongside the certificate — it embeds the envelope ID and document hash.
  const outDoc = await PDFDocument.load(signedPdfBytes);
  const keywords = (outDoc.getKeywords() || "").toString();
  assert.match(keywords, /archisign-cert-v1:\d+/, "cert marker present");
  assert.ok(keywords.includes(`envelope:101`), "envelope id in marker");
  assert.ok(keywords.includes(`hash:${documentHash}`), "doc hash in marker");
});

test("stampSignedPdf is idempotent across re-stamps (no compounding cert pages)", async () => {
  const input = await makeBlankPdf(1);
  const ctx = makeContext(202);

  const first = await stampSignedPdf(input, [], 202, "fixed_bottom_centre", ctx);
  const firstPages = await getPageCount(Buffer.from(first.signedPdfBytes));

  // Re-stamp the *already-stamped* PDF to confirm the cert-strip path runs.
  const second = await stampSignedPdf(Buffer.from(first.signedPdfBytes), [], 202, "fixed_bottom_centre", ctx);
  const secondPages = await getPageCount(Buffer.from(second.signedPdfBytes));

  assert.equal(secondPages, firstPages, "cert pages should not stack on re-stamp");
});

test("stampSignedPdf without a certificate context preserves original page count", async () => {
  const input = await makeBlankPdf(3);
  const { signedPdfBytes } = await stampSignedPdf(input, [], 303, "fixed_bottom_centre");
  const pages = await getPageCount(Buffer.from(signedPdfBytes));
  assert.equal(pages, 3, "no certificate appended when ctx omitted");
});
