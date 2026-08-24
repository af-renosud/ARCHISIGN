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
let signerAtDelivery: ((signer: any) => any) | null = null;
let deliveryClaims = new Map<number, string>();
let claimRefreshCalls = 0;
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
    originalPdfUrl: "uploads/plan-a.pdf",
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
    async getSignersByEnvelope(_envelopeId: number) {
      return getEnvelopeReturns?.signers ?? [];
    },
    async atomicClaimResendDelivery(signerId: number, claimId: string) {
      const original = getEnvelopeReturns?.signers?.find((signer: any) => signer.id === signerId);
      const candidate = signerAtDelivery ? signerAtDelivery(original) : original;
      if (candidate && original) Object.assign(original, candidate);
      if (!original || original.signedAt || deliveryClaims.has(signerId)) return undefined;
      deliveryClaims.set(signerId, claimId);
      original.resendDeliveryClaimId = claimId;
      original.resendDeliveryClaimedAt = new Date();
      return { ...original };
    },
    async releaseResendDeliveryClaim(signerId: number, claimId: string) {
      if (deliveryClaims.get(signerId) !== claimId) return;
      deliveryClaims.delete(signerId);
      const signer = getEnvelopeReturns?.signers?.find((candidate: any) => candidate.id === signerId);
      if (signer) {
        signer.resendDeliveryClaimId = null;
        signer.resendDeliveryClaimedAt = null;
      }
    },
    async refreshResendDeliveryClaim(signerId: number, claimId: string) {
      claimRefreshCalls += 1;
      if (deliveryClaims.get(signerId) !== claimId) return false;
      const signer = getEnvelopeReturns?.signers?.find((candidate: any) => candidate.id === signerId);
      if (!signer || signer.signedAt) return false;
      signer.resendDeliveryClaimedAt = new Date();
      return true;
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
  claimHeartbeatIntervalMs: 10,
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
  signerAtDelivery = null;
  deliveryClaims = new Map();
  claimRefreshCalls = 0;
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
  const ev = auditEvents.find((e) =>
    e.eventType === "Envelope resent to pending signers"
    || e.eventType === "Envelope resent to selected signers"
  );
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

test("selected signer IDs resend only to the chosen pending signer", async () => {
  getEnvelopeReturns = makeEnvelope({
    signers: [
      { id: 1, email: "a@example.com", fullName: "Signer A", signedAt: null },
      { id: 2, email: "signed@example.com", fullName: "Signed", signedAt: new Date() },
      { id: 3, email: "c@example.com", fullName: "Signer C", signedAt: null },
    ],
  });

  const r = await resend(7, { signerIds: [3], message: "For C only" });
  assert.equal(r.status, 200);
  assert.deepEqual(resendCalls, [{ email: "c@example.com", message: "For C only" }]);
  assert.deepEqual(successAudit().selectedSignerIds, [3]);
  assert.equal(successAudit().defaultedToAllPending, false);
  assert.deepEqual(r.body.resendResult, {
    attempted: 1,
    successful: 1,
    failed: 0,
    skipped: 0,
    recipients: [{
      signerId: 3,
      fullName: "Signer C",
      email: "c@example.com",
      success: true,
    }],
  });
});

test("omitting signer IDs still resends to every pending signer", async () => {
  getEnvelopeReturns = makeEnvelope({
    signers: [
      { id: 1, email: "a@example.com", fullName: "Signer A", signedAt: null },
      { id: 2, email: "b@example.com", fullName: "Signer B", signedAt: null },
      { id: 3, email: "signed@example.com", fullName: "Signed", signedAt: new Date() },
    ],
  });

  const r = await resend(7, {});
  assert.equal(r.status, 200);
  assert.deepEqual(resendCalls.map((call) => call.email), ["a@example.com", "b@example.com"]);
  assert.equal(successAudit().defaultedToAllPending, true);
});

test("an empty signer selection is rejected without sending", async () => {
  const r = await resend(7, { signerIds: [] });
  assert.equal(r.status, 400);
  assert.equal(resendCalls.length, 0);
  assert.equal(auditEvents.length, 0);
});

test("unknown, duplicate, and already-signed signer selections are rejected", async () => {
  const unknown = await resend(7, { signerIds: [999] });
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.body.invalidSignerIds, [999]);

  const signed = await resend(7, { signerIds: [2] });
  assert.equal(signed.status, 400);
  assert.deepEqual(signed.body.invalidSignerIds, [2]);

  const duplicate = await resend(7, { signerIds: [1, 1] });
  assert.equal(duplicate.status, 400);
  assert.equal(resendCalls.length, 0);
  assert.equal(auditEvents.length, 0);
});

test("explicit selections can include more than 100 pending signers", async () => {
  const signers = Array.from({ length: 101 }, (_, index) => ({
    id: index + 1,
    email: `signer-${index + 1}@example.com`,
    fullName: `Signer ${index + 1}`,
    signedAt: null,
  }));
  getEnvelopeReturns = makeEnvelope({ signers });

  const r = await resend(7, { signerIds: signers.map((signer) => signer.id) });
  assert.equal(r.status, 200);
  assert.equal(resendCalls.length, 101);
  assert.equal(r.body.resendResult.successful, 101);
});

test("a signer who completes signing before the delivery claim is skipped", async () => {
  signerAtDelivery = (signer) => ({ ...signer, signedAt: new Date() });

  const r = await resend(7, { signerIds: [1] });
  assert.equal(r.status, 409);
  assert.equal(resendCalls.length, 0);
  assert.equal(r.body.skipped[0].signerId, 1);
  const event = auditEvents.find((candidate) =>
    candidate.eventType === "Envelope resend skipped - signers no longer pending"
  );
  assert.ok(event, "expected a skipped resend audit event");
  assert.equal(JSON.parse(event.metadata).recipients[0].skipped, true);
});

test("a slow reminder provider holds no transaction and signing gets an immediate retry result", async () => {
  let markProviderStarted!: () => void;
  let releaseProvider!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    markProviderStarted = resolve;
  });
  const providerRelease = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  resendImpl = async (signer, msg) => {
    resendCalls.push({ email: signer.email, message: msg });
    markProviderStarted();
    await providerRelease;
  };

  const resendRequest = resend(7, { signerIds: [1] });
  await providerStarted;
  await new Promise((resolve) => setTimeout(resolve, 25));

  const tryAtomicSign = () => {
    const signer = getEnvelopeReturns.signers[0];
    if (signer.signedAt || signer.resendDeliveryClaimId) return false;
    signer.signedAt = new Date();
    return true;
  };
  assert.equal(tryAtomicSign(), false, "signing should immediately receive a retry result while delivery is claimed");
  assert.equal(deliveryClaims.has(1), true);
  assert.ok(claimRefreshCalls > 0, "a live delivery should renew its claim");

  releaseProvider();
  const r = await resendRequest;
  assert.equal(r.status, 200);
  assert.equal(r.body.resendResult.successful, 1);
  assert.equal(deliveryClaims.has(1), false);
  assert.equal(tryAtomicSign(), true, "signing should succeed as soon as the delivery claim is released");
});

test("partial delivery failure returns counts and audits each recipient outcome", async () => {
  getEnvelopeReturns = makeEnvelope({
    signers: [
      { id: 1, email: "a@example.com", fullName: "Signer A", signedAt: null },
      { id: 3, email: "c@example.com", fullName: "Signer C", signedAt: null },
    ],
  });
  resendImpl = async (signer, msg) => {
    resendCalls.push({ email: signer.email, message: msg });
    if (signer.id === 3) throw new Error("mailbox unavailable");
  };

  const r = await resend(7, { signerIds: [1, 3] });
  assert.equal(r.status, 200);
  assert.equal(r.body.resendResult.attempted, 2);
  assert.equal(r.body.resendResult.successful, 1);
  assert.equal(r.body.resendResult.failed, 1);
  const meta = successAudit();
  assert.deepEqual(meta.recipients.map((recipient: any) => ({
    signerId: recipient.signerId,
    success: recipient.success,
  })), [
    { signerId: 1, success: true },
    { signerId: 3, success: false },
  ]);
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

test("legacy PDF-less envelope is rejected with 409 pdf_missing, no emails or audit", async () => {
  getEnvelopeReturns = makeEnvelope({ originalPdfUrl: null });
  const r = await resend(7, { message: "x" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "pdf_missing");
  assert.equal(auditEvents.length, 0);
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
