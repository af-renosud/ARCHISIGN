import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAnchorPlacements,
  resolveExactTextPlacements,
  ANCHOR_MAX_MATCHES_PER_ANCHOR,
} from "../PdfService";

async function buildPdf(pages: Array<Array<{ text: string; x: number; y: number }>>): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const items of pages) {
    const page = doc.addPage([595.28, 841.89]);
    for (const it of items) {
      page.drawText(it.text, { x: it.x, y: it.y, size: 10, font });
    }
  }
  return Buffer.from(await doc.save());
}

test("resolveAnchorPlacements: finds a single anchor at its drawn position", async () => {
  const pdf = await buildPdf([
    [{ text: "Some contract text", x: 50, y: 700 }],
    [{ text: "{{SIGN_CLIENT}}", x: 120, y: 300 }],
  ]);
  const res = await resolveAnchorPlacements(pdf, ["{{SIGN_CLIENT}}"]);
  const matches = res.get("{{SIGN_CLIENT}}")!;
  assert.equal(matches.length, 1);
  const m = matches[0];
  assert.equal(m.pageNumber, 2);
  assert.ok(Math.abs(m.x - 120) < 3, `x ${m.x} !~ 120`);
  assert.ok(Math.abs(m.y - 300) < 3, `y ${m.y} !~ 300`);
  assert.ok(Math.abs(m.pageWidth - 595.28) < 1);
  assert.ok(Math.abs(m.pageHeight - 841.89) < 1);
});

test("resolveAnchorPlacements: multi-occurrence returns every match in page order", async () => {
  const pdf = await buildPdf([
    [{ text: "{{INIT_A}}", x: 500, y: 40 }],
    [{ text: "{{INIT_A}}", x: 500, y: 40 }],
    [{ text: "{{INIT_A}}", x: 500, y: 40 }],
  ]);
  const res = await resolveAnchorPlacements(pdf, ["{{INIT_A}}"]);
  const matches = res.get("{{INIT_A}}")!;
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map(m => m.pageNumber), [1, 2, 3]);
});

test("resolveAnchorPlacements: missing anchor yields empty bucket, others still resolve", async () => {
  const pdf = await buildPdf([
    [{ text: "{{SIGN_CONTRACTOR_1}}", x: 60, y: 120 }],
  ]);
  const res = await resolveAnchorPlacements(pdf, ["{{SIGN_CONTRACTOR_1}}", "{{SIGN_MISSING}}"]);
  assert.equal(res.get("{{SIGN_CONTRACTOR_1}}")!.length, 1);
  assert.equal(res.get("{{SIGN_MISSING}}")!.length, 0);
});

test("resolveAnchorPlacements: per-anchor cap is enforced", async () => {
  const many = Array.from({ length: ANCHOR_MAX_MATCHES_PER_ANCHOR + 5 }, (_, i) => [
    { text: "{{CAP}}", x: 50, y: 700 - (i % 3) * 20 },
  ]);
  const pdf = await buildPdf(many);
  const res = await resolveAnchorPlacements(pdf, ["{{CAP}}"]);
  assert.equal(res.get("{{CAP}}")!.length, ANCHOR_MAX_MATCHES_PER_ANCHOR);
});

test("resolveAnchorPlacements: no anchors requested returns empty map", async () => {
  const pdf = await buildPdf([[{ text: "hello", x: 50, y: 700 }]]);
  const res = await resolveAnchorPlacements(pdf, []);
  assert.equal(res.size, 0);
});

test("resolveExactTextPlacements accepts a whole trimmed line but rejects substrings", async () => {
  const pdf = await buildPdf([[
    { text: "Client Signatory", x: 50, y: 700 },
    { text: "Client Signatory Limited", x: 50, y: 650 },
  ]]);
  const res = await resolveExactTextPlacements(pdf, ["Client Signatory", "Client"]);
  assert.equal(res.get("Client Signatory")!.length, 1);
  assert.equal(res.get("Client")!.length, 0);
});
