import { test, expect, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

const BASE_URL = (
  process.env.E2E_BASE_URL || "http://localhost:5000"
).replace(/\/+$/, "");
const API_KEY = process.env.ARCHIDOC_API_KEY;
if (!API_KEY) throw new Error("ARCHIDOC_API_KEY env var must be set for E2E");
if (process.env.E2E_AUTH_BYPASS !== "1") {
  throw new Error(
    "E2E_AUTH_BYPASS=1 must be set on the server for the field-editor spec",
  );
}

const TOTAL_PAGES = 3;

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
  for (let i = 1; i <= TOTAL_PAGES; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Field Editor E2E Page ${i}`, { x: 50, y: 750, size: 20 });
  }
  return await doc.save();
}

async function createEnvelope(): Promise<{
  envelopeId: number;
  signer: CreatedSigner;
}> {
  const bytes = await buildFixturePdf();
  const ts = Date.now();
  const res = await fetch(`${BASE_URL}/api/v1/envelopes/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": API_KEY! },
    body: JSON.stringify({
      subject: `Field Editor E2E ${ts}`,
      externalRef: `field-editor-${ts}`,
      pdfBase64: Buffer.from(bytes).toString("base64"),
      signers: [
        { email: `field-editor-${ts}@example.test`, fullName: "Frida Editor" },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(
      `create envelope failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
  const json = (await res.json()) as CreateEnvelopeResponse;
  return { envelopeId: json.envelopeId, signer: json.signers[0] };
}

async function gotoFieldEditor(page: Page, envelopeId: number) {
  await page.goto(`/envelopes/${envelopeId}/fields`);
  // Wait for the editor shell to render — confirms admin auth bypass + load.
  await expect(page.getByTestId("text-editor-title")).toBeVisible();
  await expect(page.getByTestId("page-rail")).toBeVisible();
}

test.describe("Guided field-placement editor", () => {
  test("rail, guided unlock, selection, save warning, free mode", async ({
    page,
  }) => {
    const { envelopeId, signer } = await createEnvelope();
    test
      .info()
      .annotations.push({
        type: "envelope",
        description: `envelopeId=${envelopeId} signerName=${signer.fullName}`,
      });

    await gotoFieldEditor(page, envelopeId);

    // ---- Rail renders one button per page; Guided mode is the default ----
    await expect(page.getByTestId("badge-editor-mode")).toHaveText(
      /Guided mode/,
    );
    for (let p = 1; p <= TOTAL_PAGES; p++) {
      await expect(page.getByTestId(`button-page-rail-${p}`)).toBeVisible();
    }
    // Guided gating — only page 1 is unlocked initially.
    await expect(page.getByTestId("page-frame-1")).toHaveAttribute(
      "data-locked",
      "false",
    );
    await expect(page.getByTestId("page-frame-2")).toHaveAttribute(
      "data-locked",
      "true",
    );
    await expect(page.getByTestId("page-frame-3")).toHaveAttribute(
      "data-locked",
      "true",
    );

    // ---- Add a signature + initial on page 1 ----
    await expect(page.getByTestId("text-page-indicator")).toHaveText(
      `Page 1 of ${TOTAL_PAGES}`,
    );
    await page.getByTestId("button-add-signature").click();
    await page.getByTestId("button-add-initial").click();

    // Two sidebar rows for page 1 should appear (indices 0 and 1).
    const sigRow = page.getByTestId("sidebar-field-row-0");
    const initRow = page.getByTestId("sidebar-field-row-1");
    await expect(sigRow).toBeVisible();
    await expect(initRow).toBeVisible();

    // ---- Click sidebar row → matching canvas rectangle gets selected ring --
    // Prior to the click, the field is rendered with the per-type test-id.
    await expect(page.getByTestId("field-signature-0")).toBeVisible();
    await sigRow.click();
    // After selection, the canvas testid for that field switches to the
    // `field-overlay-selected-{index}` form (see editor render branch).
    await expect(page.getByTestId("field-overlay-selected-0")).toBeVisible();
    await expect(page.getByTestId("field-signature-0")).toHaveCount(0);

    // ---- "Page 1 complete" → confirm dialog → page 2 unlocks ----
    await page.getByTestId("button-confirm-page-complete").click();
    await expect(
      page.getByTestId("dialog-confirm-page-complete"),
    ).toBeVisible();
    await page.getByTestId("button-confirm-page-complete-go").click();
    await expect(
      page.getByTestId("dialog-confirm-page-complete"),
    ).toHaveCount(0);

    await expect(page.getByTestId("page-frame-2")).toHaveAttribute(
      "data-locked",
      "false",
    );
    // Page 3 is still locked (only one page unlocked at a time).
    await expect(page.getByTestId("page-frame-3")).toHaveAttribute(
      "data-locked",
      "true",
    );
    // Canvas scrolls to the freshly unlocked page → indicator reflects p2.
    await expect(page.getByTestId("text-page-indicator")).toHaveText(
      `Page 2 of ${TOTAL_PAGES}`,
    );

    // ---- Switch placement to admin_placed ----
    await page.getByTestId("select-placement-mode").click();
    await page.getByTestId("option-mode-admin").click();
    // The mutation toast is fire-and-forget; just confirm the trigger
    // settled on the new value via the locked-signature ghost disappearing
    // from the canvas (only rendered in fixed_bottom_centre mode).
    await expect(page.getByTestId("preview-locked-signature")).toHaveCount(0);

    // ---- Remove the signature field → save → save-warning dialog ----
    // The signature field is index 0; removing it shifts the initial to 0,
    // so the remove button we want is `button-remove-field-0` (signature).
    await page.getByTestId("button-remove-field-0").click();
    await expect(page.getByTestId("sidebar-field-row-0")).toBeVisible(); // initial moved to slot 0
    await expect(page.getByTestId("field-signature-0")).toHaveCount(0);

    await page.getByTestId("button-save-fields").click();
    await expect(page.getByTestId("dialog-save-warning")).toBeVisible();
    await expect(
      page.getByTestId("save-warning-section-signature"),
    ).toBeVisible();
    await expect(
      page.getByTestId(`save-warning-missing-${signer.fullName}`),
    ).toContainText(signer.fullName);

    // Dismiss the dialog before swapping editor mode.
    await page.getByTestId("button-cancel-save").click();
    await expect(page.getByTestId("dialog-save-warning")).toHaveCount(0);

    // ---- Switch to Free mode → all pages render unlocked immediately ----
    await page.getByTestId("select-editor-mode").click();
    await page.getByTestId("option-editor-mode-free").click();
    await expect(page.getByTestId("badge-editor-mode")).toHaveText(/Free mode/);

    for (let p = 1; p <= TOTAL_PAGES; p++) {
      await expect(page.getByTestId(`page-frame-${p}`)).toHaveAttribute(
        "data-locked",
        "false",
      );
    }
    // Frontier prompt should be gone (it only renders in guided mode while
    // there are still locked pages).
    await expect(page.getByTestId("guided-next-prompt")).toHaveCount(0);
  });
});
