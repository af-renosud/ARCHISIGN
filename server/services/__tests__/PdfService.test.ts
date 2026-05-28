import { test } from "node:test";
import assert from "node:assert/strict";
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

// Extract concatenated text from every page using pdfjs-dist (already a
// runtime dependency for the client viewer). pdf-lib alone cannot read text
// back from compressed content streams.
async function extractAllText(buf: Uint8Array | Buffer): Promise<string> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: buf instanceof Uint8Array ? new Uint8Array(buf) : new Uint8Array(buf),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: undefined,
  });
  const doc = await loadingTask.promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    out.push(content.items.map((it: any) => it.str || "").join(" "));
  }
  return out.join("\n--PAGE--\n");
}

function makeContext(envelopeId: number): EnvelopeCertificateContext {
  const completedAt = new Date("2026-05-25T11:54:29Z");
  return {
    envelopeId,
    subject: "Test Envelope Subject",
    externalRef: "EXT-123",
    status: "Completed",
    origin: "archidoc",
    firmName: "Test Firm",
    firmEmail: "firm@test.example",
    senderIpAddress: "203.0.113.42",
    timeZone: "UTC",
    totalDocumentPages: 2,
    signatureCount: 1,
    initialCount: 1,
    envelopeCreatedAt: new Date("2026-05-20T09:00:00Z"),
    envelopeCompletedAt: completedAt,
    signers: [
      {
        id: 42,
        fullName: "Spencer Livermore",
        email: "spencer.livermore@example.com",
        signedAt: completedAt,
        sentAt: new Date("2026-05-20T10:00:00Z"),
        resentAt: new Date("2026-05-23T08:00:00Z"),
        lastViewedAt: new Date("2026-05-25T11:52:58Z"),
        otpIssuedAt: new Date("2026-05-25T11:50:00Z"),
        otpVerifiedAt: new Date("2026-05-25T11:51:00Z"),
        signerIpAddress: "51.191.67.211",
        signerUserAgent: "Mozilla/5.0 Test",
      },
    ],
    auditEvents: [
      { eventType: "Envelope Sent", actorEmail: "admin@firm", ipAddress: "203.0.113.42", timestamp: new Date("2026-05-20T10:00:00Z") },
      { eventType: "Envelope Resent", actorEmail: "spencer.livermore@example.com", timestamp: new Date("2026-05-23T08:00:00Z") },
      { eventType: "Document signed", actorEmail: "spencer.livermore@example.com", timestamp: completedAt },
    ],
  };
}

test("stampSignedPdf appends a certificate page that contains envelope ID, signer email, and completion timestamp", async () => {
  const input = await makeBlankPdf(2);
  const baselinePages = await getPageCount(input);
  assert.equal(baselinePages, 2);

  const ctx = makeContext(101);
  const { signedPdfBytes, documentHash } = await stampSignedPdf(input, [], 101, "fixed_bottom_centre", ctx);

  const outBuf = Buffer.from(signedPdfBytes);
  const finalPages = await getPageCount(outBuf);
  assert.ok(finalPages > baselinePages, `expected more pages, got ${finalPages}`);
  assert.match(documentHash, /^[0-9a-f]{64}$/);

  // Metadata marker carries envelope ID + content hash.
  const outDoc = await PDFDocument.load(signedPdfBytes);
  const keywords = (outDoc.getKeywords() || "").toString();
  assert.match(keywords, /archisign-cert-v1:\d+/);
  assert.ok(keywords.includes("envelope:101"));
  assert.ok(keywords.includes(`hash:${documentHash}`));

  // Required acceptance content present on certificate page(s).
  const text = await extractAllText(signedPdfBytes);
  const certSection = text.split("--PAGE--").slice(baselinePages).join("\n");
  assert.ok(certSection.includes("Certificate of Completion"), "title present");
  assert.ok(certSection.includes("101"), "envelope id present");
  assert.ok(certSection.includes("spencer.livermore@example.com"), "signer email present");
  assert.ok(certSection.includes("2026-05-25 11:54:29 UTC"), "completion timestamp present");
  assert.ok(certSection.includes("203.0.113.42"), "sender IP present");
  assert.ok(/Certificate Pages/.test(certSection), "certificate page-count field present");
  assert.ok(/Time zone/.test(certSection), "time zone field present");
  assert.ok(/Milestones/.test(certSection), "milestone section present");
  assert.ok(/Signature adoption/.test(certSection), "signature adoption note present");
  assert.ok(/Test Firm\s*<\s*firm@test\.example\s*>/.test(certSection), "originator combines firm name and admin email");

  // Exactly the certificate pages declared in the marker are appended.
  const markerCount = Number(keywords.match(/archisign-cert-v1:(\d+)/)![1]);
  assert.equal(finalPages, baselinePages + markerCount, "appended pages match marker");
});

test("stampSignedPdf is idempotent across re-stamps (no compounding cert pages)", async () => {
  const input = await makeBlankPdf(1);
  const ctx = makeContext(202);

  const first = await stampSignedPdf(input, [], 202, "fixed_bottom_centre", ctx);
  const firstPages = await getPageCount(Buffer.from(first.signedPdfBytes));

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
