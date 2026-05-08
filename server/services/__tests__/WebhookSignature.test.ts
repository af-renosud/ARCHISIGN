import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseV2TenantConfig,
  describeV2TenantConfig,
  isV2Enabled,
  resetV2TenantConfigCache,
  validateV2TenantConfig,
  signV1,
  signV2,
  verifyV1,
  verifyV2,
  REPLAY_WINDOW_MS,
} from "../WebhookSignature";

function withEnv(allowlist: string | undefined, disabled: string | undefined, fn: () => void) {
  const prevAllow = process.env.ARCHISIGN_WEBHOOK_V2_TENANTS;
  const prevDis = process.env.ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS;
  if (allowlist === undefined) delete process.env.ARCHISIGN_WEBHOOK_V2_TENANTS;
  else process.env.ARCHISIGN_WEBHOOK_V2_TENANTS = allowlist;
  if (disabled === undefined) delete process.env.ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS;
  else process.env.ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS = disabled;
  resetV2TenantConfigCache();
  try {
    fn();
  } finally {
    if (prevAllow === undefined) delete process.env.ARCHISIGN_WEBHOOK_V2_TENANTS;
    else process.env.ARCHISIGN_WEBHOOK_V2_TENANTS = prevAllow;
    if (prevDis === undefined) delete process.env.ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS;
    else process.env.ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS = prevDis;
    resetV2TenantConfigCache();
  }
}

test("parseV2TenantConfig: CSV single tenant", () => {
  const cfg = parseV2TenantConfig("architrak", undefined);
  assert.equal(cfg.source, "csv");
  assert.deepEqual(cfg.legacyAllowlist, ["architrak"]);
  assert.equal(cfg.parseError, undefined);
});

test("parseV2TenantConfig: CSV multi-tenant with whitespace", () => {
  const cfg = parseV2TenantConfig(" architrak , otherTenant ,, ", undefined);
  assert.equal(cfg.source, "csv");
  assert.deepEqual(cfg.legacyAllowlist, ["architrak", "otherTenant"]);
});

test("parseV2TenantConfig: JSON map happy path", () => {
  const cfg = parseV2TenantConfig('{"architrak":"per-tenant-secret-xyz"}', undefined);
  assert.equal(cfg.source, "json");
  assert.deepEqual(cfg.legacyAllowlist, ["architrak"]);
});

test("parseV2TenantConfig: JSON map multi-key", () => {
  const cfg = parseV2TenantConfig('{"a":"x","b":"y"}', undefined);
  assert.equal(cfg.source, "json");
  assert.deepEqual(cfg.legacyAllowlist?.sort(), ["a", "b"]);
});

test("parseV2TenantConfig: malformed JSON yields parseError + empty allowlist", () => {
  const cfg = parseV2TenantConfig('{"broken json', undefined);
  assert.equal(cfg.source, "error");
  assert.deepEqual(cfg.legacyAllowlist, []);
  assert.ok(cfg.parseError);
});

test("parseV2TenantConfig: JSON array (not object) treated as parse error", () => {
  const cfg = parseV2TenantConfig('["architrak"]', undefined);
  assert.equal(cfg.source, "error");
  assert.deepEqual(cfg.legacyAllowlist, []);
});

test("parseV2TenantConfig: empty string sets allowlist to []", () => {
  const cfg = parseV2TenantConfig("", undefined);
  assert.deepEqual(cfg.legacyAllowlist, []);
});

test("parseV2TenantConfig: whitespace-only sets allowlist to []", () => {
  const cfg = parseV2TenantConfig("   \n\t  ", undefined);
  assert.deepEqual(cfg.legacyAllowlist, []);
});

test("parseV2TenantConfig: undefined env var means default-on (legacyAllowlist null)", () => {
  const cfg = parseV2TenantConfig(undefined, undefined);
  assert.equal(cfg.legacyAllowlist, null);
});

test("parseV2TenantConfig: disabled list is parsed independently", () => {
  const cfg = parseV2TenantConfig(undefined, "tenantA, tenantB");
  assert.equal(cfg.legacyAllowlist, null);
  assert.deepEqual(cfg.disabled, ["tenantA", "tenantB"]);
});

test("describeV2TenantConfig: WARN on parse error", () => {
  const cfg = parseV2TenantConfig("{bad", undefined);
  const line = describeV2TenantConfig(cfg);
  assert.equal(line.level, "WARN");
  assert.match(line.message, /could not be parsed/);
});

test("describeV2TenantConfig: INFO when intentionally empty", () => {
  const cfg = parseV2TenantConfig("", undefined);
  const line = describeV2TenantConfig(cfg);
  assert.equal(line.level, "INFO");
  assert.match(line.message, /intentionally OFF/);
});

test("describeV2TenantConfig: INFO default-on", () => {
  const cfg = parseV2TenantConfig(undefined, undefined);
  const line = describeV2TenantConfig(cfg);
  assert.equal(line.level, "INFO");
  assert.match(line.message, /ON for all tenants by default/);
});

test("describeV2TenantConfig: INFO default-on with opt-outs", () => {
  const cfg = parseV2TenantConfig(undefined, "tenantA");
  const line = describeV2TenantConfig(cfg);
  assert.match(line.message, /opted-out tenants: tenantA/);
});

test("isV2Enabled: legacy allowlist mode — only listed tenants enabled", () => {
  withEnv("architrak", undefined, () => {
    assert.equal(isV2Enabled("architrak"), true);
    assert.equal(isV2Enabled("archidoc"), false);
  });
});

test("isV2Enabled: JSON-map allowlist works the same as CSV", () => {
  withEnv('{"architrak":"key"}', undefined, () => {
    assert.equal(isV2Enabled("architrak"), true);
    assert.equal(isV2Enabled("archidoc"), false);
  });
});

test("isV2Enabled: malformed allowlist disables v2 for everyone (legacy semantics)", () => {
  withEnv("{broken", undefined, () => {
    assert.equal(isV2Enabled("architrak"), false);
    assert.equal(isV2Enabled("archidoc"), false);
  });
});

test("isV2Enabled: default-on when both env vars unset", () => {
  withEnv(undefined, undefined, () => {
    assert.equal(isV2Enabled("architrak"), true);
    assert.equal(isV2Enabled("archidoc"), true);
    assert.equal(isV2Enabled("anyNewTenant"), true);
  });
});

test("isV2Enabled: default-on minus disabled-list opt-outs", () => {
  withEnv(undefined, "archidoc,anotherTenant", () => {
    assert.equal(isV2Enabled("architrak"), true);
    assert.equal(isV2Enabled("archidoc"), false);
    assert.equal(isV2Enabled("anotherTenant"), false);
  });
});

test("isV2Enabled: legacy allowlist takes precedence over disabled list when both set", () => {
  withEnv("architrak", "architrak", () => {
    // allowlist mode wins; architrak is on the allowlist so it stays enabled regardless of disabled list
    assert.equal(isV2Enabled("architrak"), true);
    assert.equal(isV2Enabled("archidoc"), false);
  });
});

test("validateV2TenantConfig: emits exactly one log line per call (default-on)", () => {
  withEnv(undefined, undefined, () => {
    const lines: string[] = [];
    validateV2TenantConfig((line) => lines.push(line));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[startup\] INFO:/);
    assert.match(lines[0], /ON for all tenants by default/);
  });
});

test("validateV2TenantConfig: emits exactly one WARN line on parse error", () => {
  withEnv("{broken", undefined, () => {
    const lines: string[] = [];
    validateV2TenantConfig((line) => lines.push(line));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[startup\] WARN:/);
    assert.match(lines[0], /could not be parsed/);
  });
});

test("validateV2TenantConfig: emits exactly one INFO line for legacy allowlist mode", () => {
  withEnv("architrak,otherTenant", undefined, () => {
    const lines: string[] = [];
    validateV2TenantConfig((line) => lines.push(line));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[startup\] INFO:/);
    assert.match(lines[0], /architrak/);
  });
});

test("validateV2TenantConfig: each call emits exactly one line (no accumulation across calls)", () => {
  withEnv("architrak", undefined, () => {
    const lines: string[] = [];
    validateV2TenantConfig((line) => lines.push(line));
    validateV2TenantConfig((line) => lines.push(line));
    validateV2TenantConfig((line) => lines.push(line));
    assert.equal(lines.length, 3);
  });
});

test("parsed config is cached: isV2Enabled lookups after validateV2TenantConfig do not re-log or re-parse", () => {
  withEnv("architrak", undefined, () => {
    const lines: string[] = [];
    validateV2TenantConfig((line) => lines.push(line));
    assert.equal(lines.length, 1);

    // Many subsequent isV2Enabled lookups must not invoke the log function again.
    for (let i = 0; i < 100; i++) {
      isV2Enabled("architrak");
      isV2Enabled("archidoc");
      isV2Enabled("anyTenant");
    }
    assert.equal(lines.length, 1, "isV2Enabled lookups must not produce additional log lines");

    // Sanity: cached config still drives gating decisions correctly.
    assert.equal(isV2Enabled("architrak"), true);
    assert.equal(isV2Enabled("archidoc"), false);
  });
});

test("parsed config is cached: env mutation after validate is ignored until cache reset", () => {
  withEnv("architrak", undefined, () => {
    const lines: string[] = [];
    validateV2TenantConfig((line) => lines.push(line));
    assert.equal(lines.length, 1);

    // Mutate env behind the cache's back; isV2Enabled should still use the cached config.
    process.env.ARCHISIGN_WEBHOOK_V2_TENANTS = "archidoc";
    assert.equal(isV2Enabled("architrak"), true);
    assert.equal(isV2Enabled("archidoc"), false);
    assert.equal(lines.length, 1, "no boot banner re-emitted from isV2Enabled path");

    // After explicit reset, a fresh validate picks up the new env and emits one new line.
    resetV2TenantConfigCache();
    validateV2TenantConfig((line) => lines.push(line));
    assert.equal(lines.length, 2);
    assert.equal(isV2Enabled("architrak"), false);
    assert.equal(isV2Enabled("archidoc"), true);
  });
});

test("isV2Enabled: empty/missing tenantKey is always false", () => {
  withEnv(undefined, undefined, () => {
    assert.equal(isV2Enabled(undefined), false);
    assert.equal(isV2Enabled(null), false);
    assert.equal(isV2Enabled(""), false);
  });
});

// ---------------------------------------------------------------------------
// verifyV1
// ---------------------------------------------------------------------------

const V1_SECRET = "v1-test-secret";
const V1_BODY = '{"event":"envelope.sent","envelopeId":"abc"}';

test("verifyV1: missing header returns missing_header", () => {
  const res = verifyV1(V1_BODY, V1_SECRET, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing_header");
});

test("verifyV1: empty array header returns missing_header", () => {
  const res = verifyV1(V1_BODY, V1_SECRET, []);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing_header");
});

test("verifyV1: length mismatch returns length_mismatch", () => {
  const res = verifyV1(V1_BODY, V1_SECRET, "deadbeef");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "length_mismatch");
});

test("verifyV1: signature mismatch (same length, wrong bytes) returns signature_mismatch", () => {
  const wrong = "0".repeat(64);
  const res = verifyV1(V1_BODY, V1_SECRET, wrong);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "signature_mismatch");
});

test("verifyV1: signature computed with wrong secret returns signature_mismatch", () => {
  const wrongSig = signV1(V1_BODY, "different-secret");
  const res = verifyV1(V1_BODY, V1_SECRET, wrongSig);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "signature_mismatch");
});

test("verifyV1: valid signature returns ok", () => {
  const sig = signV1(V1_BODY, V1_SECRET);
  const res = verifyV1(V1_BODY, V1_SECRET, sig);
  assert.equal(res.ok, true);
  assert.equal(res.reason, undefined);
});

test("verifyV1: array header takes first element", () => {
  const sig = signV1(V1_BODY, V1_SECRET);
  const res = verifyV1(V1_BODY, V1_SECRET, [sig, "ignored"]);
  assert.equal(res.ok, true);
});

// ---------------------------------------------------------------------------
// verifyV2
// ---------------------------------------------------------------------------

const V2_SECRET = "v2-test-secret";
const V2_BODY = '{"event":"envelope.signed","envelopeId":"xyz"}';

test("verifyV2: missing both headers returns missing_header", () => {
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY,
    timestampHeader: undefined,
    signatureHeader: undefined,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing_header");
});

test("verifyV2: missing timestamp header returns missing_header", () => {
  const { signature } = signV2(V2_BODY, V2_SECRET);
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY,
    timestampHeader: undefined,
    signatureHeader: signature,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing_header");
});

test("verifyV2: missing signature header returns missing_header", () => {
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY,
    timestampHeader: String(Date.now()),
    signatureHeader: undefined,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing_header");
});

test("verifyV2: malformed timestamp returns malformed_timestamp", () => {
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY,
    timestampHeader: "not-a-number",
    signatureHeader: "0".repeat(64),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "malformed_timestamp");
});

test("verifyV2: stale timestamp (older than replay window) returns stale_timestamp", () => {
  const now = Date.now();
  const stale = now - REPLAY_WINDOW_MS - 1000;
  const { signature } = signV2(V2_BODY, V2_SECRET, stale);
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY,
    timestampHeader: String(stale),
    signatureHeader: signature,
    now,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "stale_timestamp");
});

test("verifyV2: future timestamp beyond replay window returns stale_timestamp", () => {
  const now = Date.now();
  const future = now + REPLAY_WINDOW_MS + 1000;
  const { signature } = signV2(V2_BODY, V2_SECRET, future);
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY,
    timestampHeader: String(future),
    signatureHeader: signature,
    now,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "stale_timestamp");
});

test("verifyV2: length mismatch returns length_mismatch", () => {
  const ts = Date.now();
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY,
    timestampHeader: String(ts),
    signatureHeader: "deadbeef",
    now: ts,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "length_mismatch");
});

test("verifyV2: signature mismatch (same length, wrong bytes) returns signature_mismatch", () => {
  const ts = Date.now();
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY,
    timestampHeader: String(ts),
    signatureHeader: "0".repeat(64),
    now: ts,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "signature_mismatch");
});

test("verifyV2: wrong secret returns signature_mismatch", () => {
  const ts = Date.now();
  const { signature } = signV2(V2_BODY, "different-secret", ts);
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY,
    timestampHeader: String(ts),
    signatureHeader: signature,
    now: ts,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "signature_mismatch");
});

test("verifyV2: tampered body returns signature_mismatch", () => {
  const ts = Date.now();
  const { signature } = signV2(V2_BODY, V2_SECRET, ts);
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY + " ",
    timestampHeader: String(ts),
    signatureHeader: signature,
    now: ts,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "signature_mismatch");
});

test("verifyV2: valid signature returns ok", () => {
  const ts = Date.now();
  const { signature } = signV2(V2_BODY, V2_SECRET, ts);
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY,
    timestampHeader: String(ts),
    signatureHeader: signature,
    now: ts,
  });
  assert.equal(res.ok, true);
  assert.equal(res.reason, undefined);
});

test("verifyV2: sha256= prefix is stripped before comparison", () => {
  const ts = Date.now();
  const { header } = signV2(V2_BODY, V2_SECRET, ts);
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY,
    timestampHeader: String(ts),
    signatureHeader: header,
    now: ts,
  });
  assert.equal(res.ok, true);
});

test("verifyV2: array headers take first element", () => {
  const ts = Date.now();
  const { signature } = signV2(V2_BODY, V2_SECRET, ts);
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY,
    timestampHeader: [String(ts), "ignored"],
    signatureHeader: [signature, "ignored"],
    now: ts,
  });
  assert.equal(res.ok, true);
});

test("verifyV2: timestamp at exact replay window boundary is accepted", () => {
  const now = Date.now();
  const boundary = now - REPLAY_WINDOW_MS;
  const { signature } = signV2(V2_BODY, V2_SECRET, boundary);
  const res = verifyV2({
    secret: V2_SECRET,
    rawBody: V2_BODY,
    timestampHeader: String(boundary),
    signatureHeader: signature,
    now,
  });
  assert.equal(res.ok, true);
});
