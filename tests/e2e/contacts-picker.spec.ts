import { test, expect } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

const BASE_URL = (process.env.E2E_BASE_URL || "http://localhost:5000").replace(/\/+$/, "");
const API_KEY = process.env.ARCHIDOC_API_KEY;
if (!API_KEY) throw new Error("ARCHIDOC_API_KEY env var must be set for E2E");
if (process.env.E2E_AUTH_BYPASS !== "1") {
  throw new Error("E2E_AUTH_BYPASS=1 must be set on the server for the contacts-picker spec");
}

async function seedArchidocContact(id: string, email: string, displayName: string, sourceUpdatedAt: string) {
  const res = await fetch(`${BASE_URL}/api/v1/contacts/archidoc/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-API-KEY": API_KEY! },
    body: JSON.stringify({ email, displayName, category: "client", sourceUpdatedAt }),
  });
  if (!res.ok) throw new Error(`Failed to seed contact ${id}: ${res.status}`);
}

async function createEnvelopeWithSigner(email: string, displayName: string) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText("Recent-bump fixture", { x: 50, y: 750, size: 20 });
  const bytes = await doc.save();
  const pdfBase64 = Buffer.from(bytes).toString("base64");
  const res = await fetch(`${BASE_URL}/api/v1/envelopes/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": API_KEY! },
    body: JSON.stringify({
      title: `Recent bump ${Date.now()}`,
      pdfBase64,
      signers: [{ email, displayName, role: "signer" }],
      identityVerification: { method: "otp_email" },
    }),
  });
  if (!res.ok) throw new Error(`Envelope create failed: ${res.status} ${await res.text()}`);
}

test.describe("Contacts picker on New Envelope", () => {
  test("groups Archidoc results, supports inline add-as-new and bumps Recent", async ({ page }) => {
    const stamp = Date.now();
    const archidocId = `e2e-archi-${stamp}`;
    const archidocEmail = `picker.archi.${stamp}@example.com`;
    await seedArchidocContact(archidocId, archidocEmail, `E2E Archi ${stamp}`, new Date().toISOString());

    await page.goto(`${BASE_URL}/envelopes/new`);
    await page.getByTestId("primary-signer-trigger").click();
    const search = page.getByTestId("primary-signer-search");
    await search.fill(`picker.archi.${stamp}`);

    const archidocRow = page.locator(`[data-testid^="primary-signer-item-"]`).filter({ hasText: archidocEmail });
    await expect(archidocRow).toBeVisible();
    await expect(archidocRow.getByText("ArchiDoc", { exact: false })).toBeVisible();
    await archidocRow.click();
    await expect(page.getByTestId("primary-signer-trigger")).toContainText(archidocEmail);

    const newEmail = `picker.local.${stamp}@example.com`;
    await page.getByTestId("button-add-signer").click();
    await page.getByTestId("additional-signer-0-trigger").click();
    await page.getByTestId("additional-signer-0-search").fill(newEmail);
    await expect(page.getByTestId("additional-signer-0-add-new")).toBeVisible();
    await page.getByTestId("additional-signer-0-add-new").click();
    await expect(page.getByTestId("additional-signer-0-trigger")).toContainText(newEmail);

    // Trigger Recent ordering bump by actually creating an envelope using the picker's email.
    await createEnvelopeWithSigner(archidocEmail, `E2E Archi ${stamp}`);

    await page.reload();
    await page.getByTestId("primary-signer-trigger").click();
    const recentGroup = page.locator('[cmdk-group-heading]:has-text("Recent")');
    await expect(recentGroup).toBeVisible();
    const recentSection = page.locator('[cmdk-group]').filter({ has: page.locator('[cmdk-group-heading]:has-text("Recent")') });
    await expect(recentSection.getByText(archidocEmail)).toBeVisible();
  });
});
