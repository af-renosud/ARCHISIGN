import { test, expect } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

const BASE_URL = (process.env.E2E_BASE_URL || "http://localhost:5000").replace(/\/+$/, "");
if (process.env.E2E_AUTH_BYPASS !== "1") {
  throw new Error("E2E_AUTH_BYPASS=1 must be set on the server for the sidebar-status-filter spec");
}

async function makePdfBytes(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText("Sidebar filter fixture", { x: 50, y: 750, size: 20 });
  return Buffer.from(await doc.save());
}

// Seed a draft envelope via the admin endpoint (auth bypassed).
async function seedDraft(subject: string) {
  const form = new FormData();
  form.append("subject", subject);
  form.append("signers", JSON.stringify([{ fullName: "Sidebar Tester", email: `sidebar.${Date.now()}@example.com` }]));
  form.append("pdf", new Blob([new Uint8Array(await makePdfBytes())], { type: "application/pdf" }), "fixture.pdf");
  const res = await fetch(`${BASE_URL}/api/envelopes`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Envelope seed failed: ${res.status} ${await res.text()}`);
  return res.json();
}

test.describe("Sidebar status filters", () => {
  test("clicking a sidebar status filters the dashboard; clearing restores the default view", async ({ page }) => {
    const stamp = Date.now();
    const draftSubject = `Sidebar Draft ${stamp}`;
    await seedDraft(draftSubject);

    await page.goto(`${BASE_URL}/`);

    // Click "Draft" in the sidebar.
    await page.getByTestId("button-status-draft").click();
    await expect(page).toHaveURL(/\?status=draft/);
    await expect(page.getByTestId("button-status-filter")).toContainText("Draft");
    await expect(page.getByText(draftSubject)).toBeVisible();
    // Sidebar row shows active state.
    await expect(page.getByTestId("button-status-draft")).toHaveAttribute("aria-pressed", "true");

    // Switch to "Signed" — only signed remain, draft disappears.
    await page.getByTestId("button-status-signed").click();
    await expect(page).toHaveURL(/\?status=signed/);
    await expect(page.getByText(draftSubject)).not.toBeVisible();

    // Clearing via the filter popover's Default returns to the normal view.
    await page.getByTestId("button-status-filter").click();
    await page.getByTestId("button-status-filter-default").click();
    await expect(page).not.toHaveURL(/status=/);
    await expect(page.getByTestId("button-status-signed")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText(draftSubject)).toBeVisible();
  });

  test("back/forward keeps URL, filter, and stored selection aligned", async ({ page }) => {
    const stamp = Date.now();
    const draftSubject = `Sidebar BackNav ${stamp}`;
    await seedDraft(draftSubject);

    // Seed a non-default stored selection before the app loads.
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "archisign:dashboard:statusFilter",
        JSON.stringify(["sent", "viewed"]),
      );
    });

    await page.goto(`${BASE_URL}/`);
    await expect(page.getByText(draftSubject)).not.toBeVisible(); // stored filter excludes drafts

    await page.getByTestId("button-status-draft").click();
    await expect(page).toHaveURL(/\?status=draft/);
    await expect(page.getByText(draftSubject)).toBeVisible();

    // Back: param gone, stored selection restored, localStorage untouched.
    await page.goBack();
    await expect(page).not.toHaveURL(/status=/);
    await expect(page.getByText(draftSubject)).not.toBeVisible();
    await expect(page.getByTestId("button-status-draft")).toHaveAttribute("aria-pressed", "false");
    const stored = await page.evaluate(() =>
      window.localStorage.getItem("archisign:dashboard:statusFilter"),
    );
    expect(JSON.parse(stored!)).toEqual(["sent", "viewed"]);

    // Forward: param-driven view returns.
    await page.goForward();
    await expect(page).toHaveURL(/\?status=draft/);
    await expect(page.getByText(draftSubject)).toBeVisible();
  });

  test("direct link ?status=draft pre-filters on load", async ({ page }) => {
    const stamp = Date.now();
    const draftSubject = `Sidebar Deep Link ${stamp}`;
    await seedDraft(draftSubject);

    await page.goto(`${BASE_URL}/?status=draft`);
    await expect(page.getByTestId("button-status-filter")).toContainText("Draft");
    await expect(page.getByText(draftSubject)).toBeVisible();
    await expect(page.getByTestId("button-status-draft")).toHaveAttribute("aria-pressed", "true");
  });
});
