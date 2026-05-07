import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { createHash } from "crypto";
import { PDFDocument, decodePDFRawStream, PDFArray, PDFRawStream } from "pdf-lib";

const SHA256_OF_123456 =
  "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92";

if (createHash("sha256").update("123456").digest("hex") !== SHA256_OF_123456) {
  throw new Error("SHA-256 constant for OTP 123456 is incorrect");
}

const BASE_URL = (
  process.env.E2E_BASE_URL || "http://localhost:5000"
).replace(/\/+$/, "");
const API_KEY = process.env.ARCHIDOC_API_KEY;
const DB_URL = process.env.DATABASE_URL;
if (!API_KEY) throw new Error("ARCHIDOC_API_KEY env var must be set for E2E");
if (!DB_URL) throw new Error("DATABASE_URL env var must be set for E2E");

interface CreatedSigner {
  id: number;
  email: string;
  fullName: string;
  accessToken: string;
}

interface CreateEnvelopeResponse {
  envelopeId: number;
  signers: CreatedSigner[];
}

async function buildFixturePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= 3; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Guided Signing E2E Page ${i}`, { x: 50, y: 750, size: 20 });
  }
  return await doc.save();
}

async function createEnvelope(): Promise<{
  envelopeId: number;
  signerId: number;
  accessToken: string;
}> {
  const bytes = await buildFixturePdf();
  const ts = Date.now();
  const res = await fetch(`${BASE_URL}/api/v1/envelopes/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": API_KEY! },
    body: JSON.stringify({
      subject: `Guided E2E ${ts}`,
      externalRef: `guided-${ts}`,
      pdfBase64: Buffer.from(bytes).toString("base64"),
      signers: [{ email: `guided-${ts}@example.test`, fullName: "Eve Guided" }],
    }),
  });
  if (!res.ok) throw new Error(`create envelope failed: HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as CreateEnvelopeResponse;
  return {
    envelopeId: json.envelopeId,
    signerId: json.signers[0].id,
    accessToken: json.signers[0].accessToken,
  };
}

async function seedKnownOtp(pool: Pool, signerId: number) {
  // Test seam: replace the freshly generated OTP hash with sha256("123456")
  // so the test can drive the real /verify-otp endpoint via the UI without
  // depending on Gmail delivery. otp_verified is NOT touched — the real
  // endpoint sets it when the user submits the code through the UI.
  const r = await pool.query(
    `UPDATE signers
       SET otp_code = $1,
           otp_expires_at = NOW() + INTERVAL '10 minutes'
     WHERE id = $2
       AND otp_verified = false
     RETURNING id`,
    [SHA256_OF_123456, signerId],
  );
  if (r.rowCount !== 1) {
    throw new Error(`seedKnownOtp affected ${r.rowCount} rows for signer ${signerId}`);
  }
}

async function typeOtp(page: Page, code: string) {
  // input-otp library renders a single <input data-testid="input-otp"> behind
  // the visible slot grid. Filling it triggers onChange on every digit.
  const otp = page.getByTestId("input-otp");
  await otp.fill(code);
}

async function downloadSignedPdf(accessToken: string): Promise<Buffer> {
  const r = await fetch(`${BASE_URL}/api/sign/${accessToken}/download`);
  if (r.status !== 200) throw new Error(`download HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.subarray(0, 4).toString() !== "%PDF") throw new Error("not a PDF");
  return buf;
}

async function extractLastPageContent(buf: Buffer): Promise<string> {
  const pdf = await PDFDocument.load(buf);
  const last = pdf.getPages()[pdf.getPageCount() - 1];
  const c = last.node.Contents();
  if (!c) throw new Error("last page has no content stream");
  const items =
    c instanceof PDFArray
      ? c.asArray().map((x) => pdf.context.lookup(x))
      : [c];
  let merged = "";
  for (const s of items) {
    if (!(s instanceof PDFRawStream)) continue;
    merged += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  }
  return merged;
}

test.describe("Guided signing flow", () => {
  let pool: Pool;
  test.beforeAll(() => {
    pool = new Pool({ connectionString: DB_URL });
  });
  test.afterAll(async () => {
    await pool.end();
  });

  test("complete external-signer journey end-to-end", async ({ page }) => {
    const { envelopeId, signerId, accessToken } = await createEnvelope();
    test.info().annotations.push({
      type: "envelope",
      description: `envelopeId=${envelopeId} signerId=${signerId}`,
    });

    // ---- OTP via UI -------------------------------------------------------
    await page.goto(`/sign/${accessToken}`);
    await expect(page.getByTestId("button-request-otp")).toBeVisible();

    await page.getByTestId("button-request-otp").click();
    await expect(page.getByTestId("input-otp")).toBeVisible();

    await seedKnownOtp(pool, signerId);

    await typeOtp(page, "123456");
    await page.getByTestId("button-verify-otp").click();

    // ---- Banner + Start gate ---------------------------------------------
    await page.waitForURL(`**/sign/${accessToken}/document`);
    await expect(page.getByTestId("text-doc-subject")).toBeVisible();

    await expect(page.getByTestId("banner-top-instructions")).toContainText(
      "Review the document first and when you are ready to proceed click start",
    );
    await expect(page.getByTestId("review-mode-container")).toBeVisible();
    await expect(page.getByTestId("button-start-signing")).toBeVisible();
    await expect(page.getByTestId("stepper-progress")).toHaveCount(0);
    await expect(page.getByTestId("button-initial-page-1")).toHaveCount(0);

    await page.getByTestId("button-start-signing").click();
    await expect(page.getByTestId("dialog-start-confirm")).toBeVisible();
    await page.getByTestId("button-confirm-start").click();

    // ---- Wizard initial state --------------------------------------------
    await expect(page.getByTestId("stepper-progress")).toBeVisible();
    await expect(page.getByTestId("text-step-label")).toContainText("Step 1 of 4");
    await expect(page.getByTestId("text-page-indicator")).toHaveText("Page 1 of 3");
    await expect(page.getByTestId("badge-initial-progress")).toHaveText("0/3 initialed");
    await expect(page.getByTestId("button-initial-page-1")).toBeVisible();
    await expect(page.getByTestId("button-prev-page")).toBeDisabled();
    // Forward-skip is impossible while only page 1 is current.
    await expect(page.getByTestId("button-initial-page-2")).toHaveCount(0);
    await expect(page.getByTestId("button-initial-page-3")).toHaveCount(0);

    // ---- Initial page 1 → auto-advance to page 2 -------------------------
    await page.getByTestId("button-initial-page-1").click();
    await expect(page.getByTestId("text-page-indicator")).toHaveText("Page 2 of 3");
    await expect(page.getByTestId("badge-initial-progress")).toHaveText("1/3 initialed");
    await expect(page.getByTestId("button-initial-page-2")).toBeVisible();
    await expect(page.getByTestId("button-initial-page-3")).toHaveCount(0); // still no skip
    await expect(page.getByTestId("button-prev-page")).toBeEnabled();

    // ---- Restricted back-nav: only to already-initialed pages ------------
    await page.getByTestId("button-prev-page").click();
    await expect(page.getByTestId("text-page-indicator")).toHaveText("Page 1 of 3");
    await expect(page.getByTestId("badge-initialed-page-1")).toBeVisible();
    await expect(page.getByTestId("button-initial-page-1")).toHaveCount(0);
    await expect(page.getByTestId("button-prev-page")).toBeDisabled();

    // ---- Reload-resume: jumps to next un-initialed page ------------------
    await page.reload();
    await expect(page.getByTestId("text-page-indicator")).toHaveText("Page 2 of 3");
    await expect(page.getByTestId("button-initial-page-2")).toBeVisible();

    // ---- Initial pages 2 + 3 ---------------------------------------------
    await page.getByTestId("button-initial-page-2").click();
    await expect(page.getByTestId("text-page-indicator")).toHaveText("Page 3 of 3");
    await expect(page.getByTestId("badge-initial-progress")).toHaveText("2/3 initialed");

    await page.getByTestId("button-initial-page-3").click();
    await expect(page.getByTestId("text-step-label")).toContainText("Final Step");
    await expect(page.getByTestId("text-ready-to-sign")).toBeVisible();
    await expect(page.getByTestId("text-signature-preview")).toBeVisible();
    await expect(page.getByTestId("badge-initial-progress")).toHaveText("3/3 initialed");
    await expect(page.getByTestId("button-final-sign")).toBeEnabled();

    // ---- Final signature -------------------------------------------------
    await page.getByTestId("button-final-sign").click();
    await expect(page.getByTestId("text-confirm-signature-preview")).toContainText("Eve Guided");
    await page.getByTestId("button-confirm-sign").click();

    // ---- Signed view -----------------------------------------------------
    await expect(page.getByTestId("digital-envelope-box")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("text-digital-envelope-title")).toHaveText("DIGITAL ENVELOPE");
    await expect(page.getByTestId("text-signed-by")).toContainText("EVE GUIDED");
    await expect(page.getByTestId("text-script-signature")).toBeVisible();
    await expect(page.getByTestId("button-download-signed-pdf")).toBeVisible();

    // ---- Download + geometry assertion -----------------------------------
    const buf = await downloadSignedPdf(accessToken);
    const merged = await extractLastPageContent(buf);
    expect(
      merged.includes("DIGITAL ENVELOPE") ||
        merged.includes("4449474954414C20454E56454C4F5045"),
      "stamped PDF must embed the DIGITAL ENVELOPE label on the last page",
    ).toBe(true);

    // The PDF stream emits one `cm` (translate-only) followed by the
    // outline path: `0 0 m 0 H l W H l` for the signature rectangle.
    const rectMatch = merged.match(
      /(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s+cm[\s\S]*?0\s+0\s+m\s+0\s+(-?\d+\.?\d*)\s+l\s+(-?\d+\.?\d*)\s+\3\s+l/,
    );
    expect(rectMatch, "could not locate signature rectangle path on last page").not.toBeNull();
    const [, xs, ys, hs, ws] = rectMatch!;
    const x = parseFloat(xs);
    const y = parseFloat(ys);
    const w = parseFloat(ws);
    const h = parseFloat(hs);

    const pdf = await PDFDocument.load(buf);
    const lastPage = pdf.getPages()[pdf.getPageCount() - 1];
    const pageW = lastPage.getWidth();

    const horizontalCentreOffsetPt = Math.abs(x + w / 2 - pageW / 2);
    const bottomPaddingMm = y / 2.83465;

    test.info().annotations.push({
      type: "signature-geometry",
      description: JSON.stringify({ x, y, w, h, pageW, horizontalCentreOffsetPt, bottomPaddingMm }),
    });

    expect(horizontalCentreOffsetPt).toBeLessThanOrEqual(1);
    expect(Math.abs(bottomPaddingMm - 10)).toBeLessThanOrEqual(1);
  });
});
