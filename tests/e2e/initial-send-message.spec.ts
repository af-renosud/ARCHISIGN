import { test, expect } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

const BASE_URL = (process.env.E2E_BASE_URL || "http://localhost:5000").replace(/\/+$/, "");
if (process.env.E2E_AUTH_BYPASS !== "1") {
  throw new Error("E2E_AUTH_BYPASS=1 must be set on the server for the initial-send-message spec");
}

async function makePdfBytes(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText("Initial send message fixture", { x: 50, y: 750, size: 20 });
  return Buffer.from(await doc.save());
}

async function seedDraft(subject: string, message: string) {
  const form = new FormData();
  form.append("subject", subject);
  form.append("message", message);
  form.append("signers", JSON.stringify([
    { fullName: "Message Tester", email: `message.${Date.now()}@example.com` },
  ]));
  form.append(
    "pdf",
    new Blob([new Uint8Array(await makePdfBytes())], { type: "application/pdf" }),
    "fixture.pdf",
  );
  const res = await fetch(`${BASE_URL}/api/envelopes`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Envelope seed failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ id: number }>;
}

test.describe("Contextual message before initial send", () => {
  test("envelope detail prompts, pre-fills, cancels safely, and submits the message", async ({ page }) => {
    const envelope = await seedDraft(`Detail message ${Date.now()}`, "Existing context");
    let sendBody: unknown = null;
    await page.route(`**/api/envelopes/${envelope.id}/send`, async (route) => {
      sendBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${BASE_URL}/envelopes/${envelope.id}`);
    await page.getByTestId("button-send-envelope").click();

    await expect(page.getByTestId("dialog-send-envelope")).toBeVisible();
    await expect(page.getByTestId("input-send-message")).toHaveValue("Existing context");
    await expect(page.getByTestId("input-send-message")).toHaveAttribute("maxlength", "5000");

    await page.getByTestId("button-cancel-send").click();
    await expect(page.getByTestId("dialog-send-envelope")).not.toBeVisible();
    expect(sendBody).toBeNull();

    await page.getByTestId("button-send-envelope").click();
    await page.getByTestId("input-send-message").fill("Please sign by Friday.\nThank you.");
    await page.getByTestId("button-confirm-send").click();

    await expect.poll(() => sendBody).toEqual({
      message: "Please sign by Friday.\nThank you.",
    });
    await expect(page.getByTestId("dialog-send-envelope")).not.toBeVisible();
  });

  test("field editor shows the same prompt after its placement warning", async ({ page }) => {
    const envelope = await seedDraft(`Editor message ${Date.now()}`, "Editor context");
    let sendBody: unknown = null;
    await page.route(`**/api/envelopes/${envelope.id}/send`, async (route) => {
      sendBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${BASE_URL}/envelopes/${envelope.id}/fields`);
    await page.getByTestId("button-send-envelope").click();

    // The fixture intentionally has no initial fields, so the existing warning
    // comes first; confirming it must continue to the new message opportunity.
    await expect(page.getByTestId("dialog-save-warning")).toBeVisible();
    await page.getByTestId("button-save-anyway").click();
    await expect(page.getByTestId("dialog-send-envelope")).toBeVisible();
    await expect(page.getByTestId("input-send-message")).toHaveValue("Editor context");

    await page.getByTestId("input-send-message").fill("Context sent from the field editor.");
    await page.getByTestId("button-confirm-send").click();

    await expect.poll(() => sendBody).toEqual({
      message: "Context sent from the field editor.",
    });
  });
});