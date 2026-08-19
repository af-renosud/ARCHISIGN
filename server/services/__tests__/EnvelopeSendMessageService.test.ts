import test from "node:test";
import assert from "node:assert/strict";
import { sendEnvelopeRequestSchema } from "@shared/schema";
import {
  claimEnvelopeForInitialSend,
  InitialEnvelopeSendError,
  sendEnvelopeForSigning,
} from "../EnvelopeSendService";

function makeEnvelope(message: string | null = "Existing message") {
  return { id: 17, message, subject: "Plan A" };
}

test("send message schema trims input and enforces the 5,000 character limit", () => {
  const parsed = sendEnvelopeRequestSchema.parse({ message: "  Please sign by Friday.  " });
  assert.equal(parsed.message, "Please sign by Friday.");

  const tooLong = sendEnvelopeRequestSchema.safeParse({ message: "x".repeat(5001) });
  assert.equal(tooLong.success, false);
});

test("atomically claims with an explicitly supplied message before returning the delivery envelope", async () => {
  const claims: Array<{ id: number; data: any }> = [];
  const claimedAt = new Date("2026-08-19T16:00:00.000Z");
  const storage = {
    async atomicClaimEnvelopeSend(id: number, at: Date, data: any) {
      assert.equal(at, claimedAt);
      claims.push({ id, data });
      return { ...makeEnvelope(), ...data, status: "sent", updatedAt: at };
    },
  };

  const result = await claimEnvelopeForInitialSend(
    makeEnvelope(),
    sendEnvelopeRequestSchema.parse({ message: "  Context for signer  " }),
    claimedAt,
    storage as any,
  );

  assert.deepEqual(claims, [{ id: 17, data: { message: "Context for signer" } }]);
  assert.equal(result?.message, "Context for signer");
});

test("blank explicitly clears a prior message; omitted claims without changing it", async () => {
  const updates: any[] = [];
  const storage = {
    async atomicClaimEnvelopeSend(_id: number, _at: Date, data: any) {
      updates.push(data);
      return { ...makeEnvelope(), ...(data ?? {}), status: "sent" };
    },
  };
  const claimedAt = new Date();

  const cleared = await claimEnvelopeForInitialSend(
    makeEnvelope(),
    sendEnvelopeRequestSchema.parse({ message: "   " }),
    claimedAt,
    storage as any,
  );
  assert.equal(cleared?.message, null);
  assert.deepEqual(updates, [{ message: null }]);

  updates.length = 0;
  const preserved = await claimEnvelopeForInitialSend(
    makeEnvelope(),
    sendEnvelopeRequestSchema.parse({}),
    claimedAt,
    storage as any,
  );
  assert.equal(preserved?.message, "Existing message");
  assert.deepEqual(updates, [undefined]);
});

test("concurrent claims allow only one caller to reach delivery", async () => {
  let status = "draft";
  let invitationLoops = 0;
  const storage = {
    async atomicClaimEnvelopeSend(_id: number, at: Date, data: any) {
      if (status !== "draft") return null;
      status = "sent";
      return { ...makeEnvelope(), ...(data ?? {}), status, updatedAt: at };
    },
  };

  const deliver = async (message: string) => {
    const claimed = await claimEnvelopeForInitialSend(
      makeEnvelope(),
      sendEnvelopeRequestSchema.parse({ message }),
      new Date(),
      storage as any,
    );
    if (!claimed) return false;
    invitationLoops += 1;
    return true;
  };

  const results = await Promise.all([deliver("First"), deliver("Second")]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(invitationLoops, 1);
});

function makeFullEnvelope(overrides: Record<string, any> = {}) {
  return {
    id: 17,
    status: "draft",
    subject: "Plan A",
    externalRef: null,
    message: "Existing message",
    originalPdfUrl: "/uploads/plan-a.pdf",
    gmailThreadId: null,
    webhookUrl: null,
    origin: null,
    signers: [
      {
        id: 91,
        email: "signer@example.com",
        fullName: "Signer One",
        accessToken: "token-1",
      },
    ],
    communicationLogs: [],
    auditEvents: [],
    updatedAt: new Date("2026-08-19T15:00:00.000Z"),
    ...overrides,
  };
}

function makeSendHarness(options: { failEmail?: boolean } = {}) {
  let envelope = makeFullEnvelope();
  const invitations: Array<{ message: string | null; email: string }> = [];
  const audits: any[] = [];
  let releases = 0;

  const storage = {
    async getEnvelope(id: number) {
      return id === envelope.id ? envelope : undefined;
    },
    async atomicClaimEnvelopeSend(id: number, at: Date, update: any) {
      if (id !== envelope.id || envelope.status !== "draft") return null;
      envelope = { ...envelope, ...(update ?? {}), status: "sent", updatedAt: at };
      return envelope;
    },
    async atomicReleaseEnvelopeSend(id: number, claimedAt: Date) {
      if (
        id !== envelope.id ||
        envelope.status !== "sent" ||
        envelope.updatedAt !== claimedAt
      ) {
        return null;
      }
      releases += 1;
      envelope = { ...envelope, status: "draft", updatedAt: new Date() };
      return envelope;
    },
    async updateEnvelope(_id: number, update: any) {
      envelope = { ...envelope, ...update, updatedAt: new Date() };
      return envelope;
    },
    async createAuditEvent(event: any) {
      audits.push(event);
      return event;
    },
  };

  const deps = {
    storage: storage as any,
    getGmailProfile: async () => "admin@example.com",
    loadEmailSettings: async () => ({
      registrationLine: "REG",
      footerText: "FOOT",
      firmName: "Archisign",
      invitationBody: "Please sign.",
      otpBody: "OTP",
      completionBody: "DONE",
      subjectPrefix: "Signature Required:",
    }),
    sendSigningInvitation: async (signer: any, claimed: any) => {
      invitations.push({ message: claimed.message, email: signer.email });
      if (options.failEmail) throw new Error("mail unavailable");
      return {};
    },
    emitEvent: async () => {},
  };

  return {
    deps,
    invitations,
    audits,
    getEnvelope: () => envelope,
    getReleases: () => releases,
  };
}

test("concurrent full sends dispatch one invitation with one authoritative message", async () => {
  const harness = makeSendHarness();
  const send = (message: string) =>
    sendEnvelopeForSigning(
      {
        envelopeId: 17,
        request: sendEnvelopeRequestSchema.parse({ message }),
        baseUrl: "https://example.test",
        ipAddress: "127.0.0.1",
      },
      harness.deps as any,
    );

  const results = await Promise.allSettled([send("Message A"), send("Message B")]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const rejection = (rejected[0] as PromiseRejectedResult).reason;
  assert.ok(rejection instanceof InitialEnvelopeSendError);
  assert.equal(rejection.status, 409);
  assert.equal(rejection.details.code, "send_conflict");
  assert.equal(harness.invitations.length, 1);
  assert.equal(harness.invitations[0].message, harness.getEnvelope().message);
  assert.equal(harness.audits.filter((event) => event.eventType === "Envelope sent for signing").length, 1);
});

test("all-email-failed releases the claim back to draft and preserves message for retry", async () => {
  const harness = makeSendHarness({ failEmail: true });

  await assert.rejects(
    () =>
      sendEnvelopeForSigning(
        {
          envelopeId: 17,
          request: sendEnvelopeRequestSchema.parse({ message: "Retry this context" }),
          baseUrl: "https://example.test",
          ipAddress: "127.0.0.1",
        },
        harness.deps as any,
      ),
    (error: unknown) => {
      assert.ok(error instanceof InitialEnvelopeSendError);
      assert.equal(error.status, 502);
      assert.match(error.message, /remains in draft/);
      return true;
    },
  );

  assert.equal(harness.getReleases(), 1);
  assert.equal(harness.getEnvelope().status, "draft");
  assert.equal(harness.getEnvelope().message, "Retry this context");
  assert.equal(harness.audits.at(-1)?.eventType, "Envelope send failed - all emails failed");
});