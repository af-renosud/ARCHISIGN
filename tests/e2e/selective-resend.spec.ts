import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { PDFDocument } from "pdf-lib";

const BASE_URL = (process.env.E2E_BASE_URL || "http://localhost:5000").replace(/\/+$/, "");
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("DATABASE_URL env var must be set for E2E");
if (process.env.E2E_AUTH_BYPASS !== "1") {
  throw new Error("E2E_AUTH_BYPASS=1 must be set on the server for the selective-resend spec");
}

interface SeededSigner {
  id: number;
  fullName: string;
  email: string;
}

interface SeededEnvelope {
  id: number;
  signers: SeededSigner[];
}

async function makePdfBytes(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText("Selective resend fixture", { x: 50, y: 750, size: 20 });
  return Buffer.from(await doc.save());
}

async function seedSentEnvelope(pool: Pool): Promise<SeededEnvelope> {
  const stamp = Date.now();
  const form = new FormData();
  form.append("subject", `Selective resend ${stamp}`);
  form.append("signers", JSON.stringify([
    { fullName: "Pending One", email: `pending-one-${stamp}@example.test` },
    { fullName: "Pending Two", email: `pending-two-${stamp}@example.test` },
    { fullName: "Already Signed", email: `signed-${stamp}@example.test` },
  ]));
  form.append(
    "pdf",
    new Blob([new Uint8Array(await makePdfBytes())], { type: "application/pdf" }),
    "selective-resend.pdf",
  );
  const createResponse = await fetch(`${BASE_URL}/api/envelopes`, { method: "POST", body: form });
  if (!createResponse.ok) {
    throw new Error(`Envelope seed failed: ${createResponse.status} ${await createResponse.text()}`);
  }
  const created = await createResponse.json() as { id: number };
  const envelopeResponse = await fetch(`${BASE_URL}/api/envelopes/${created.id}`);
  if (!envelopeResponse.ok) {
    throw new Error(`Envelope fetch failed: ${envelopeResponse.status} ${await envelopeResponse.text()}`);
  }
  const envelope = await envelopeResponse.json() as SeededEnvelope;
  const signedSigner = envelope.signers.find((signer) => signer.fullName === "Already Signed")!;
  await pool.query(
    "UPDATE envelopes SET status = 'sent' WHERE id = $1",
    [envelope.id],
  );
  await pool.query(
    "UPDATE signers SET signed_at = NOW() WHERE id = $1",
    [signedSigner.id],
  );
  return envelope;
}

test.describe("Selective invitation resend", () => {
  let pool: Pool;

  test.beforeAll(() => {
    pool = new Pool({ connectionString: DB_URL });
  });

  test.afterAll(async () => {
    await pool.end();
  });

  test("defaults pending signers on and submits only the chosen recipient", async ({ page }) => {
    const envelope = await seedSentEnvelope(pool);
    const pendingOne = envelope.signers.find((signer) => signer.fullName === "Pending One")!;
    const pendingTwo = envelope.signers.find((signer) => signer.fullName === "Pending Two")!;
    const signedSigner = envelope.signers.find((signer) => signer.fullName === "Already Signed")!;
    let resendBody: unknown = null;

    await page.route(`**/api/envelopes/${envelope.id}/resend`, async (route) => {
      resendBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          resendResult: { attempted: 1, successful: 1, failed: 0, skipped: 0, recipients: [] },
        }),
      });
    });

    await page.goto(`${BASE_URL}/envelopes/${envelope.id}`);
    await page.getByTestId("button-resend-envelope").click();

    await expect(page.getByTestId("dialog-resend-invitations")).toBeVisible();
    await expect(page.getByTestId(`row-resend-recipient-${pendingOne.id}`)).toContainText("Pending One");
    await expect(page.getByTestId(`row-resend-recipient-${pendingTwo.id}`)).toContainText("Pending Two");
    await expect(page.getByTestId(`row-resend-recipient-${signedSigner.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`checkbox-resend-recipient-${pendingOne.id}`)).toBeChecked();
    await expect(page.getByTestId(`checkbox-resend-recipient-${pendingTwo.id}`)).toBeChecked();

    await page.getByTestId("button-clear-resend-recipients").click();
    await expect(page.getByTestId("text-resend-selection-count")).toHaveText("Select at least one signer.");
    await expect(page.getByTestId("button-confirm-resend")).toBeDisabled();

    await page.getByTestId(`checkbox-resend-recipient-${pendingTwo.id}`).click();
    await page.getByTestId("input-resend-message").fill("Please sign today.");
    await page.getByTestId("button-confirm-resend").click();

    await expect.poll(() => resendBody).toEqual({
      message: "Please sign today.",
      signerIds: [pendingTwo.id],
    });
    await expect(page.getByTestId("dialog-resend-invitations")).not.toBeVisible();
  });
});