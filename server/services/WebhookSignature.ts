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

export function isV2Enabled(tenantKey: string | undefined | null): boolean {
  if (!tenantKey) return false;
  const enabled = (process.env.ARCHISIGN_WEBHOOK_V2_TENANTS || "").split(",").map(s => s.trim()).filter(Boolean);
  return enabled.includes(tenantKey);
}
