import crypto from "crypto";

export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export const V1_SIGNATURE_HEADER = "x-archisign-signature";
export const V2_SIGNATURE_HEADER = "x-archisign-signature";
export const V2_TIMESTAMP_HEADER = "x-archisign-timestamp";

export function signV1(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function signV2(rawBody: string, secret: string, timestamp: number = Date.now()): { signature: string; timestamp: number; header: string } {
  const ts = String(timestamp);
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`, "utf8").digest("hex");
  return { signature: sig, timestamp, header: `sha256=${sig}` };
}

export interface VerifyV2Params {
  secret: string;
  rawBody: string;
  timestampHeader: string | string[] | undefined;
  signatureHeader: string | string[] | undefined;
  now?: number;
}

export interface VerifyResult {
  ok: boolean;
  reason?: "missing_header" | "stale_timestamp" | "malformed_timestamp" | "length_mismatch" | "signature_mismatch";
}

export function verifyV2({ secret, rawBody, timestampHeader, signatureHeader, now = Date.now() }: VerifyV2Params): VerifyResult {
  const ts = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const sig = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!ts || !sig) return { ok: false, reason: "missing_header" };

  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "malformed_timestamp" };
  if (Math.abs(now - tsNum) > REPLAY_WINDOW_MS) return { ok: false, reason: "stale_timestamp" };

  const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`, "utf8").digest("hex");
  const received = sig.replace(/^sha256=/, "");

  if (expected.length !== received.length) return { ok: false, reason: "length_mismatch" };

  try {
    const ok = crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
    return ok ? { ok: true } : { ok: false, reason: "signature_mismatch" };
  } catch {
    return { ok: false, reason: "signature_mismatch" };
  }
}

export function verifyV1(rawBody: string, secret: string, signatureHeader: string | string[] | undefined): VerifyResult {
  const sig = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!sig) return { ok: false, reason: "missing_header" };
  const expected = signV1(rawBody, secret);
  if (expected.length !== sig.length) return { ok: false, reason: "length_mismatch" };
  try {
    const ok = crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
    return ok ? { ok: true } : { ok: false, reason: "signature_mismatch" };
  } catch {
    return { ok: false, reason: "signature_mismatch" };
  }
}

// ---------------------------------------------------------------------------
// v2 tenant gating
// ---------------------------------------------------------------------------
//
// Two env vars control which tenants receive v2 dual-emit:
//
//   ARCHISIGN_WEBHOOK_V2_TENANTS         (legacy allowlist; if set, ONLY listed tenants get v2)
//   ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS (opt-out list; only consulted when the legacy allowlist is unset)
//
// Default behaviour (both vars unset): v2 is ON for every tenant.
//
// The legacy allowlist tolerates two formats:
//   1. CSV literal:  "architrak"  or  "architrak,otherTenant"
//   2. JSON map:     '{"architrak":"<per-tenant-key>"}'  (keys are taken; values ignored — true per-tenant key
//      isolation is a separate workstream)
//
// Malformed JSON or unparseable values produce a startup WARN and resolve to an empty allowlist (which under
// legacy semantics means v2 is OFF for everyone). validateV2TenantConfig() emits the WARN/INFO line at boot.

export interface V2TenantConfig {
  legacyAllowlist: string[] | null; // null = env var unset; [] = set but parsed empty
  disabled: string[];
  parseError?: string;
  source: "csv" | "json" | "empty" | "error";
}

let cachedConfig: V2TenantConfig | null = null;

export function parseV2TenantConfig(
  rawAllowlist: string | undefined,
  rawDisabled: string | undefined,
): V2TenantConfig {
  const disabled = (rawDisabled || "").split(",").map(s => s.trim()).filter(Boolean);

  if (rawAllowlist === undefined || rawAllowlist === null) {
    return { legacyAllowlist: null, disabled, source: "empty" };
  }

  const trimmed = rawAllowlist.trim();
  if (trimmed === "") {
    return { legacyAllowlist: [], disabled, source: "empty" };
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed).map(k => k.trim()).filter(Boolean);
        return { legacyAllowlist: keys, disabled, source: "json" };
      }
      return {
        legacyAllowlist: [],
        disabled,
        source: "error",
        parseError: "JSON value is not an object map",
      };
    } catch (err) {
      return {
        legacyAllowlist: [],
        disabled,
        source: "error",
        parseError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const csv = trimmed.split(",").map(s => s.trim()).filter(Boolean);
  return { legacyAllowlist: csv, disabled, source: csv.length ? "csv" : "empty" };
}

export interface V2ConfigLogLine {
  level: "WARN" | "INFO";
  message: string;
}

export function describeV2TenantConfig(cfg: V2TenantConfig): V2ConfigLogLine {
  if (cfg.parseError) {
    return {
      level: "WARN",
      message: `[startup] WARN: ARCHISIGN_WEBHOOK_V2_TENANTS could not be parsed (${cfg.parseError}); v2 dual-emit is OFF for every tenant under legacy-allowlist semantics. Fix the env var or unset it to fall back to default-on.`,
    };
  }
  if (cfg.legacyAllowlist === null) {
    if (cfg.disabled.length === 0) {
      return {
        level: "INFO",
        message: `[startup] INFO: v2 webhook dual-emit is ON for all tenants by default (no ARCHISIGN_WEBHOOK_V2_TENANTS allowlist set, no ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS opt-outs).`,
      };
    }
    return {
      level: "INFO",
      message: `[startup] INFO: v2 webhook dual-emit is ON by default; opted-out tenants: ${cfg.disabled.join(", ")}.`,
    };
  }
  if (cfg.legacyAllowlist.length === 0) {
    return {
      level: "INFO",
      message: `[startup] INFO: ARCHISIGN_WEBHOOK_V2_TENANTS is set but resolves to zero tenants — v2 dual-emit is intentionally OFF for everyone.`,
    };
  }
  return {
    level: "INFO",
    message: `[startup] INFO: v2 webhook dual-emit (legacy allowlist mode, source=${cfg.source}) active for tenants: ${cfg.legacyAllowlist.join(", ")}.`,
  };
}

export function validateV2TenantConfig(logFn: (line: string) => void = console.log): V2TenantConfig {
  const cfg = parseV2TenantConfig(
    process.env.ARCHISIGN_WEBHOOK_V2_TENANTS,
    process.env.ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS,
  );
  const line = describeV2TenantConfig(cfg);
  logFn(line.message);
  cachedConfig = cfg;
  return cfg;
}

export function resetV2TenantConfigCache(): void {
  cachedConfig = null;
}

function getConfig(): V2TenantConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = parseV2TenantConfig(
    process.env.ARCHISIGN_WEBHOOK_V2_TENANTS,
    process.env.ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS,
  );
  return cachedConfig;
}

export function isV2Enabled(tenantKey: string | undefined | null): boolean {
  if (!tenantKey) return false;
  const cfg = getConfig();
  // Precedence: if the legacy allowlist env var is set (even to empty), it is the ONLY source of truth.
  if (cfg.legacyAllowlist !== null) {
    return cfg.legacyAllowlist.includes(tenantKey);
  }
  // Default-on: every tenant gets v2 unless explicitly opted out.
  return !cfg.disabled.includes(tenantKey);
}
