import { randomBytes, randomInt, createHash, timingSafeEqual } from "crypto";

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function generateOtp(): string {
  return randomInt(100000, 1000000).toString();
}

export function hashOtp(otp: string): string {
  return createHash("sha256").update(otp).digest("hex");
}

export function verifyOtp(inputOtp: string, storedHash: string): boolean {
  const inputHash = hashOtp(String(inputOtp));
  const inputBuf = Buffer.from(inputHash, "utf-8");
  const storedBuf = Buffer.from(storedHash, "utf-8");
  if (inputBuf.length !== storedBuf.length) return false;
  return timingSafeEqual(inputBuf, storedBuf);
}

export function buildSigningLink(baseUrl: string, token: string): string {
  return `${baseUrl}/sign/${token}`;
}

export function generateAuthenticationId(signerId: number, envelopeId: number, signedAt: Date | string): string {
  return createHash("sha256")
    .update(`${signerId}-${envelopeId}-${signedAt}`)
    .digest("hex")
    .substring(0, 12)
    .toUpperCase();
}
