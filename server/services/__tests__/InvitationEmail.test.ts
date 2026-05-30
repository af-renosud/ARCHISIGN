import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInvitationBodyHtml, type EmailSettings } from "../NotificationService";

const emailCfg: EmailSettings = {
  registrationLine: "REG",
  footerText: "FOOT",
  firmName: "Archisign",
  invitationBody: "You have been invited to review and sign the following document.",
  otpBody: "OTP",
  completionBody: "DONE",
  subjectPrefix: "Signature Required:",
};

const signer = { fullName: "Jane Doe" };
const signingUrl = "https://example.test/sign/abc";

test("renders sender message under heading when present", () => {
  const html = buildInvitationBodyHtml(
    signer,
    { subject: "Plan A", externalRef: null, message: "Please sign by Friday." },
    signingUrl,
    emailCfg,
  );
  assert.match(html, /Message from the sender:/);
  assert.match(html, /Please sign by Friday\./);
});

test("omits heading and block when message is absent", () => {
  const html = buildInvitationBodyHtml(
    signer,
    { subject: "Plan A", externalRef: null, message: null },
    signingUrl,
    emailCfg,
  );
  assert.doesNotMatch(html, /Message from the sender:/);
});

test("omits heading when message is whitespace-only", () => {
  const html = buildInvitationBodyHtml(
    signer,
    { subject: "Plan A", externalRef: null, message: "   \n  " },
    signingUrl,
    emailCfg,
  );
  assert.doesNotMatch(html, /Message from the sender:/);
});

test("escapes HTML in the sender message", () => {
  const html = buildInvitationBodyHtml(
    signer,
    { subject: "Plan A", externalRef: null, message: "<script>alert(1)</script>" },
    signingUrl,
    emailCfg,
  );
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("preserves line breaks via pre-line and renders before subject box", () => {
  const html = buildInvitationBodyHtml(
    signer,
    { subject: "Plan A", externalRef: null, message: "Line 1\nLine 2" },
    signingUrl,
    emailCfg,
  );
  assert.match(html, /white-space: pre-line/);
  const msgIdx = html.indexOf("Message from the sender:");
  const subjectIdx = html.indexOf("<strong>Subject:</strong>");
  assert.ok(msgIdx > -1 && subjectIdx > -1 && msgIdx < subjectIdx, "message block must precede subject box");
});
