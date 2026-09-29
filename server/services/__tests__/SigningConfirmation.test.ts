import { test } from "node:test";
import assert from "node:assert/strict";
import { sendFirmSigningNotification, type EmailSettings } from "../NotificationService";

const cfg: EmailSettings = {
  firmName: "ArchiSign", registrationLine: "", footerText: "",
  invitationBody: "", otpBody: "", completionBody: "Everyone has signed.",
  subjectPrefix: "",
};
const envelope = { id: 49, subject: "Report <A>", externalRef: "REF&1", gmailThreadId: "invitation-thread" };
const signer = { fullName: "Alice <Smith>", email: "alice@example.test" };
const signers = [
  { fullName: signer.fullName, signedAt: new Date() },
  { fullName: "Bob", signedAt: null },
];

function harness(options: { missingRecipient?: boolean; sendFails?: boolean; profileFails?: boolean } = {}) {
  const messages: unknown[][] = [];
  const events: any[] = [];
  return {
    messages, events,
    deps: {
      getRecipient: async () => {
        if (options.profileFails) throw new Error("Profile unavailable");
        return options.missingRecipient ? null : "office@example.test";
      },
      send: async (...args: any[]) => {
        if (options.sendFails) throw new Error("Provider unavailable");
        messages.push(args);
        return { id: "message-id" };
      },
      record: async (event: any) => { events.push(event); },
    },
  };
}

test("individual signature sends to the connected Gmail address with progress and escaped details", async () => {
  const h = harness();
  await sendFirmSigningNotification(envelope, signers, "https://example.test", cfg, signer, undefined, h.deps);
  assert.equal(h.messages.length, 1);
  const [recipient, subject, html, thread] = h.messages[0];
  assert.equal(recipient, "office@example.test");
  assert.match(String(subject), /Signature received/);
  assert.match(String(html), /Alice &lt;Smith&gt;/);
  assert.match(String(html), /Report &lt;A&gt;/);
  assert.match(String(html), /REF&amp;1/);
  assert.match(String(html), /1 of 2 signers/);
  assert.match(String(html), /https:\/\/example.test\/envelopes\/49/);
  assert.doesNotMatch(String(html), /All Signatures Collected/);
  assert.equal(thread, undefined);
  assert.equal(h.events[0].eventType, "Signature confirmation email sent");
});

test("last signer gets a signature alert and a distinct final office confirmation with attachment", async () => {
  const h = harness();
  const completed = signers.map(s => ({ ...s, signedAt: new Date() }));
  const attachments = [{ filename: "signed.pdf", content: Buffer.from("pdf"), mimeType: "application/pdf" }];
  await sendFirmSigningNotification(envelope, completed, "https://example.test", cfg, signer, undefined, h.deps);
  await sendFirmSigningNotification(envelope, completed, "https://example.test", cfg, undefined, attachments, h.deps);
  assert.equal(h.messages.length, 2);
  assert.match(String(h.messages[0][2]), /2 of 2 signers/);
  assert.match(String(h.messages[1][1]), /All signatures complete/);
  assert.match(String(h.messages[1][2]), /signed document is attached/);
  assert.deepEqual(h.messages[1][4], attachments);
  assert.equal(h.messages[1][3], undefined);
  assert.equal(h.events[1].eventType, "Completion confirmation email sent");
});

test("no attachment claim when signed PDF is unavailable", async () => {
  const h = harness();
  await sendFirmSigningNotification(envelope, signers, "https://example.test", cfg, undefined, undefined, h.deps);
  assert.doesNotMatch(String(h.messages[0][2]), /document is attached/);
});

for (const options of [{ missingRecipient: true }, { profileFails: true }, { sendFails: true }]) {
  test(`mail failure is recorded without rejecting committed signing: ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    await assert.doesNotReject(sendFirmSigningNotification(envelope, signers, "https://example.test", cfg, signer, undefined, h.deps));
    assert.equal(h.messages.length, 0);
    assert.equal(h.events[0].eventType, "Signature confirmation email failed");
    assert.ok(JSON.parse(h.events[0].metadata).error);
  });
}

test("audit storage failure does not reject a successful signature notification", async () => {
  const h = harness();
  h.deps.record = async () => { throw new Error("Audit unavailable"); };
  await assert.doesNotReject(sendFirmSigningNotification(envelope, signers, "https://example.test", cfg, signer, undefined, h.deps));
  assert.equal(h.messages.length, 1);
});