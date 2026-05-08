import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseV2TenantConfig,
  describeV2TenantConfig,
  isV2Enabled,
  resetV2TenantConfigCache,
  validateV2TenantConfig,
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
