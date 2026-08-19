import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { storage } from "../../storage";

// Admin routes: envelope creation must reject a missing PDF, and sending a
// legacy PDF-less draft must be rejected with pdf_missing.

process.env.E2E_AUTH_BYPASS = "1";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.ARCHISIGN_DISABLE_SCHEDULERS = "1";

let baseUrl = "";
let httpServer: ReturnType<typeof createServer>;
const originals: Record<string, any> = {};

before(async () => {
  const { registerRoutes } = await import("../../routes");
  const app = express();
  app.use(express.json());
  httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

after(async () => {
  for (const [k, v] of Object.entries(originals)) (storage as any)[k] = v;
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  const { pool } = await import("../../db");
  await pool.end().catch(() => {});
});

test("admin create: missing PDF file -> 400 with pdf field error", async () => {
  const form = new FormData();
  form.append("subject", "Plans without a document");
  form.append("signers", JSON.stringify([{ fullName: "Signer One", email: "s1@example.com" }]));
  const res = await fetch(`${baseUrl}/api/envelopes`, { method: "POST", body: form });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.message, /PDF document is required/);
  assert.deepEqual(body.errors?.pdf, ["A PDF document is required"]);
});

function withPdflessEnvelope(fn: () => Promise<void>) {
  originals.getEnvelope = (storage as any).getEnvelope;
  (storage as any).getEnvelope = async (id: number) =>
    id === 424242
      ? {
          id,
          status: "draft",
          originalPdfUrl: null,
          signers: [{ id: 1, email: "s1@example.com", fullName: "Signer One" }],
          externalRef: null,
          origin: null,
          webhookUrl: null,
          gmailThreadId: null,
        }
      : originals.getEnvelope.call(storage, id);
  return fn().finally(() => {
    (storage as any).getEnvelope = originals.getEnvelope;
    delete originals.getEnvelope;
  });
}

test("admin send: draft with no originalPdfUrl -> 409 pdf_missing", () =>
  withPdflessEnvelope(async () => {
    const res = await fetch(`${baseUrl}/api/envelopes/424242/send`, { method: "POST" });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "pdf_missing");
  }));

test("admin send: contextual message over 5,000 characters -> 400 before delivery", async () => {
  const res = await fetch(`${baseUrl}/api/envelopes/424242/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "x".repeat(5001) }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.message, "Invalid send data");
  assert.match(body.errors?.message?.[0] ?? "", /5,000 characters or fewer/);
});

test("admin reply: envelope with no originalPdfUrl -> 409 pdf_missing", () =>
  withPdflessEnvelope(async () => {
    const res = await fetch(`${baseUrl}/api/envelopes/424242/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "pdf_missing");
  }));
