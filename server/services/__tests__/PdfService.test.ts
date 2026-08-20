import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from "pdf-lib";
import {
  fitSignatureFontSize,
  getPageCount,
  MAX_SIGNATURE_FONT_SIZE,
  SIGNATURE_BLOCK_HEX,
  stampSignedPdf,
  type EnvelopeCertificateContext,
} from "../PdfService";

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

async function extractPageContent(buf: Uint8Array | Buffer, pageIndex: number): Promise<string> {
  const pdf = await PDFDocument.load(buf);
  const contents = pdf.getPage(pageIndex).node.Contents();
  if (!contents) return "";
  const streams = contents instanceof PDFArray
    ? contents.asArray().map((entry) => pdf.context.lookup(entry))
    : [contents];
  return streams
    .filter((stream): stream is PDFRawStream => stream instanceof PDFRawStream)
    .map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1"))
    .join("\n");
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

test("signature names are capped at 18 pt and reduced to fit their available width", () => {
  const proportionalFont = {
    widthOfTextAtSize(text: string, size: number) {
      return text.length * size * 0.55;
    },
  };

  assert.equal(
    fitSignatureFontSize(proportionalFont, "Ada Lovelace", 200),
    MAX_SIGNATURE_FONT_SIZE,
  );

  const longName = "Alexandria Catherine Montgomery-Worthington";
  const fitted = fitSignatureFontSize(proportionalFont, longName, 180);
  assert.ok(fitted < MAX_SIGNATURE_FONT_SIZE);
  assert.ok(
    proportionalFont.widthOfTextAtSize(longName, fitted) <= 180,
    "fitted name stays within the signature line",
  );
  assert.equal(SIGNATURE_BLOCK_HEX, "#0F2C59");

  const extremeName = "Alexandria ".repeat(1_000);
  const extremeSize = fitSignatureFontSize(proportionalFont, extremeName, 180);
  assert.ok(extremeSize > 0);
  assert.ok(
    proportionalFont.widthOfTextAtSize(extremeName, extremeSize) <= 180,
    "even an extreme name is reduced enough to avoid crossing the signature line",
  );
});

test("stampSignedPdf embeds a long Satisfy signature name without dropping text", async () => {
  const input = await makeBlankPdf(1);
  const fullName = "Alexandria Catherine Montgomery-Worthington";
  const { signedPdfBytes } = await stampSignedPdf(
    input,
    [{
      signer: {
        id: 501,
        fullName,
        signedAt: new Date("2026-08-20T10:30:00Z"),
      },
      annotations: [{
        pageNumber: 1,
        xPos: 0.1,
        yPos: 0.2,
        width: 0.36,
        height: null,
        type: "signature",
        value: fullName,
      }],
    }],
    501,
    "admin_placed",
  );

  const text = await extractAllText(signedPdfBytes);
  assert.ok(text.includes(fullName), "full long signer name remains embedded in the PDF");
  assert.ok(text.includes("DIGITAL ENVELOPE"), "signature certification text remains present");

  const content = await extractPageContent(signedPdfBytes, 0);
  const satisfySizeMatch = content.match(/\/Satisfy-Regular-\d+\s+([\d.]+)\s+Tf/);
  assert.ok(satisfySizeMatch, "Satisfy is the embedded signature font");
  const renderedSize = Number(satisfySizeMatch[1]);
  assert.ok(renderedSize < MAX_SIGNATURE_FONT_SIZE, "long signer name is reduced below 18 pt");
  assert.ok(renderedSize > 1, "fitted signer name remains legible");
  assert.match(
    content,
    /0\.0588235294\d*\s+0\.1725490196\d*\s+0\.3490196078\d*\s+RG/,
    "signature block border uses #0F2C59",
  );
});

test("stampSignedPdf renders creator-defined fixed text without brackets", async () => {
  const input = await makeBlankPdf(1);
  const fixedText = "Sign in the marked location";
  const { signedPdfBytes } = await stampSignedPdf(
    input,
    [
      {
        signer: {
          id: 601,
          fullName: "Fixed Text Owner",
          signedAt: new Date("2026-08-20T10:30:00Z"),
        },
        annotations: [{
          pageNumber: 1,
          xPos: 0.12,
          yPos: 0.25,
          width: 0.3,
          height: 0.04,
          type: "text",
          value: fixedText,
        }],
      },
      {
        signer: {
          id: 602,
          fullName: "Second Signer",
          signedAt: new Date("2026-08-20T10:31:00Z"),
        },
        annotations: [],
      },
    ],
    601,
    "admin_placed",
  );

  const text = await extractAllText(signedPdfBytes);
  assert.ok(text.includes(fixedText));
  assert.equal(text.split(fixedText).length - 1, 1, "global fixed text is stamped exactly once");
  assert.ok(!text.includes(`[${fixedText}]`), "fixed text is stamped as document content, not a placeholder");
});

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
