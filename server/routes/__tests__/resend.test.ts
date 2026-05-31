import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { buildResendHandler, type ResendHandlerDeps } from "../resend";

let baseUrl = "";
let server: ReturnType<express.Application["listen"]>;

// Captured side effects, reset before each test.
let auditEvents: any[] = [];
let getEnvelopeReturns: any = null;
let getEnvelopeCalls = 0;
let updateEnvelopeCalls: any[] = [];
let resendCalls: any[] = [];
// Indirection so individual tests can swap the resend implementation after
// the handler has already captured its deps at build time.
let resendImpl: (signer: any, msg: any) => Promise<void> = async (signer, msg) => {
  resendCalls.push({ email: signer.email, message: msg });
};

// A fake envelope whose `message` field is sentinel-tagged so the test can
// prove a resend never mutates the persisted note.
function makeEnvelope(overrides: Record<string, any> = {}) {
  return {
    id: 7,
    status: "sent",
    subject: "Plan A",
    message: "ORIGINAL_PERSISTED_MESSAGE",
    signers: [
      { id: 1, email: "a@example.com", fullName: "Signer A", signedAt: null },
      { id: 2, email: "b@example.com", fullName: "Signer B", signedAt: new Date() },
    ],
    ...overrides,
  };
}

const fakeDeps: Partial<ResendHandlerDeps> = {
  storage: {
    async getEnvelope(_id: number) {
      getEnvelopeCalls += 1;
      return getEnvelopeReturns;
    },
    async createAuditEvent(ev: any) {
      auditEvents.push(ev);
      return ev;
    },
    // Present so any accidental persistence write is observable; the resend
    // handler must never call it.
    async updateEnvelope(id: number, patch: any) {
      updateEnvelopeCalls.push({ id, patch });
      return null;
    },
  } as any,
  async sendResendInvitation(signer: any, _env: any, _baseUrl: any, _cfg: any, msg: any) {
    await resendImpl(signer, msg);
  },
  async loadEmailSettings() {
    return {} as any;
  },
  async getGmailProfile() {
    return "firm@example.com";
  },
};

before(async () => {
  const app = express();
  app.use(express.json());
  app.post("/api/envelopes/:id/resend", buildResendHandler(fakeDeps));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  auditEvents = [];
  getEnvelopeReturns = makeEnvelope();
  getEnvelopeCalls = 0;
  updateEnvelopeCalls = [];
  resendCalls = [];
  resendImpl = async (signer, msg) => {
    resendCalls.push({ email: signer.email, message: msg });
  };
});

async function resend(id: number, body?: any) {
  const res = await fetch(`${baseUrl}/api/envelopes/${id}/resend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { status: res.status, body: json };
}

function successAudit() {
  const ev = auditEvents.find((e) => e.eventType === "Envelope resent to pending signers");
  assert.ok(ev, "expected a success audit event");
  return JSON.parse(ev.metadata);
}

test("resend with a message records messageIncluded: true", async () => {
  const r = await resend(7, { message: "Please sign by Friday." });
  assert.equal(r.status, 200);
  assert.equal(successAudit().messageIncluded, true);
});

test("resend without a message records messageIncluded: false", async () => {
  const r = await resend(7, {});
  assert.equal(r.status, 200);
  assert.equal(successAudit().messageIncluded, false);
});

test("resend with whitespace-only message records messageIncluded: false", async () => {
  const r = await resend(7, { message: "   \n\t  " });
  assert.equal(r.status, 200);
  assert.equal(successAudit().messageIncluded, false);
});

test("resend with null message records messageIncluded: false", async () => {
  const r = await resend(7, { message: null });
  assert.equal(r.status, 200);
  assert.equal(successAudit().messageIncluded, false);
});

test("reminder behavior is unchanged regardless of message presence", async () => {
  // Only the unsigned signer (a@example.com) should be emailed in both cases.
  await resend(7, { message: "hi" });
  assert.deepEqual(resendCalls.map((c) => c.email), ["a@example.com"]);
  assert.equal(resendCalls[0].message, "hi");

  resendCalls = [];
  await resend(7, {});
  assert.deepEqual(resendCalls.map((c) => c.email), ["a@example.com"]);
  assert.equal(resendCalls[0].message, null);
});

test("resend never mutates envelopes.message (with a message)", async () => {
  await resend(7, { message: "transient note that must not persist" });
  assert.equal(updateEnvelopeCalls.length, 0, "resend must not write to the envelope");
  assert.equal(
    getEnvelopeReturns.message,
    "ORIGINAL_PERSISTED_MESSAGE",
    "persisted message must be untouched",
  );
});

test("resend never mutates envelopes.message (without a message)", async () => {
  await resend(7, {});
  assert.equal(updateEnvelopeCalls.length, 0, "resend must not write to the envelope");
  assert.equal(getEnvelopeReturns.message, "ORIGINAL_PERSISTED_MESSAGE");
});

test("transient message is not persisted into any audit metadata field", async () => {
  const secret = "DO_NOT_LEAK_THIS_NOTE";
  await resend(7, { message: secret });
  for (const ev of auditEvents) {
    assert.ok(
      !String(ev.metadata ?? "").includes(secret),
      "audit metadata must not contain the message text",
    );
  }
});

test("all-emails-failed path still records messageIncluded and 502s", async () => {
  resendImpl = async () => {
    throw new Error("smtp down");
  };
  const r = await resend(7, { message: "urgent" });
  assert.equal(r.status, 502);
  const ev = auditEvents.find((e) => e.eventType === "Envelope resend failed - all emails failed");
  assert.ok(ev, "expected a failure audit event");
  const meta = JSON.parse(ev.metadata);
  assert.equal(meta.messageIncluded, true);
  assert.ok(!ev.metadata.includes("urgent"), "failure metadata must not contain message text");
});

test("non-resendable status is rejected with 400", async () => {
  getEnvelopeReturns = makeEnvelope({ status: "signed" });
  const r = await resend(7, { message: "x" });
  assert.equal(r.status, 400);
  assert.equal(auditEvents.length, 0);
});

test("all signers already signed is rejected with 400", async () => {
  getEnvelopeReturns = makeEnvelope({
    signers: [{ id: 1, email: "a@example.com", fullName: "A", signedAt: new Date() }],
  });
  const r = await resend(7, {});
  assert.equal(r.status, 400);
  assert.equal(resendCalls.length, 0);
});
