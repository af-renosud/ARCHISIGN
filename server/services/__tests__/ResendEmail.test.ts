import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResendBodyHtml } from "../NotificationService";

const signer = { fullName: "Jane Doe" };
const signingUrl = "https://example.test/sign/abc";
const envelope = { subject: "Plan A", externalRef: null };

test("renders custom message under heading when present", () => {
  const html = buildResendBodyHtml(signer, envelope, signingUrl, "Please sign by Friday.");
  assert.match(html, /Message from the sender:/);
  assert.match(html, /Please sign by Friday\./);
});

test("omits heading and block when message is absent", () => {
  const html = buildResendBodyHtml(signer, envelope, signingUrl, null);
  assert.doesNotMatch(html, /Message from the sender:/);
});

test("omits heading when message is undefined", () => {
  const html = buildResendBodyHtml(signer, envelope, signingUrl);
  assert.doesNotMatch(html, /Message from the sender:/);
});

test("omits heading when message is whitespace-only", () => {
  const html = buildResendBodyHtml(signer, envelope, signingUrl, "   \n  ");
  assert.doesNotMatch(html, /Message from the sender:/);
});

test("escapes HTML in the custom message", () => {
  const html = buildResendBodyHtml(signer, envelope, signingUrl, "<script>alert(1)</script>");
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("preserves line breaks via pre-line and renders before subject box", () => {
  const html = buildResendBodyHtml(signer, envelope, signingUrl, "Line 1\nLine 2");
  assert.match(html, /white-space: pre-line/);
  const msgIdx = html.indexOf("Message from the sender:");
  const subjectIdx = html.indexOf("<strong>Subject:</strong>");
  assert.ok(msgIdx > -1 && subjectIdx > -1 && msgIdx < subjectIdx, "message block must precede subject box");
});
