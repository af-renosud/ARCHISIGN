import crypto from "crypto";
import { storage } from "../storage";
import { signV1, signV2, isV2Enabled, V2_TIMESTAMP_HEADER } from "./WebhookSignature";
import type { Envelope, WebhookDelivery } from "@shared/schema";

export type CanonicalEvent =
  | "envelope.sent"
  | "envelope.queried"
  | "envelope.query_resolved"
  | "envelope.declined"
  | "envelope.expired"
  | "envelope.signed"
  | "envelope.retention_breach";

export const CANONICAL_EVENTS: ReadonlySet<CanonicalEvent> = new Set<CanonicalEvent>([
  "envelope.sent",
  "envelope.queried",
  "envelope.query_resolved",
  "envelope.declined",
  "envelope.expired",
  "envelope.signed",
  "envelope.retention_breach",
]);

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1_000, 3_000, 10_000, 30_000];
const TIMEOUT_MS = 10_000;

/**
 * UUIDv7 generator — RFC 9562 §5.7 (time-ordered, 48-bit ms timestamp + 74 random bits).
 * Used for event dedup keys (G6: AS3 + AT5 use UUIDv7; Archidoc's re-mint path uses
 * deterministic synthesis distinguished by event_source).
 */
export function uuidv7(timestampMs: number = Date.now()): string {
  const ts = BigInt(timestampMs);
  const tsHex = ts.toString(16).padStart(12, "0");
  const rand = crypto.randomBytes(10);
  // Set version (7) in top 4 bits of byte 6
  rand[0] = (rand[0] & 0x0f) | 0x70;
  // Set variant (10) in top 2 bits of byte 8
  rand[2] = (rand[2] & 0x3f) | 0x80;
  const randHex = rand.toString("hex");
  return [
    tsHex.slice(0, 8),
    tsHex.slice(8, 12),
    randHex.slice(0, 4),
    randHex.slice(4, 8),
    randHex.slice(8, 20),
  ].join("-");
}

export interface CommonEnvelopeFields {
  envelopeId: number;
  externalRef: string | null;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
}

export type EventSpecificData =
  | { event: "envelope.sent"; signers: Array<{ email: string; name: string }> }
  | { event: "envelope.queried"; queryId: string; signerEmail: string; queryText: string; queriedAt: string }
  | { event: "envelope.query_resolved"; queryId: string; resolvedAt: string; resolverSource: "archisign_admin_ui" | "external"; resolverEmail: string | null; resolverActor: "architect" | "system"; resolutionNote: string | null }
  | { event: "envelope.declined"; declinedBy: string; declinedAt: string; declineReason: string }
  | { event: "envelope.expired"; expiredAt: string }
  | { event: "envelope.signed"; signedAt: string; signedPdfFetchUrl: string; signedPdfFetchUrlExpiresAt: string; identityVerification: IdentityVerification }
  | { event: "envelope.retention_breach"; originalSignedAt: string; detectedAt: string; incidentRef: string; remediationContact: string };

export interface IdentityVerification {
  method: "otp_email";
  otpIssuedAt: string;
  otpVerifiedAt: string;
  signerIpAddress: string;
  signerUserAgent: string;
  lastViewedAt: string;
  signedAt: string;
  authenticationId: string;
}

/**
 * Pure constructor for the §3.2 common envelope + §3.3 per-event additional fields.
 * Output is a stable plain object suitable for byte-equal fixture comparison
 * (G1: AS3 will assert against docs/wire-fixtures/ in Architrak's repo).
 */
export function buildEventPayload(
  eventId: string,
  common: CommonEnvelopeFields,
  eventData: EventSpecificData,
): Record<string, unknown> {
  const { event, ...rest } = eventData;
  return {
    eventId,
    event,
    envelopeId: common.envelopeId,
    externalRef: common.externalRef,
    metadata: common.metadata,
    occurredAt: common.occurredAt,
    ...rest,
  };
}

export interface EmitOptions {
  webhookUrl: string;
  envelope: Pick<Envelope, "id" | "externalRef" | "origin">;
  eventData: EventSpecificData;
  metadata?: Record<string, unknown> | null;
  occurredAt?: Date;
  /** Optional explicit eventId (for replay or deterministic emission). Defaults to UUIDv7. */
  eventId?: string;
  /** Tenant identifier used to gate v2 dual-emit (matches ARCHISIGN_WEBHOOK_V2_TENANTS). */
  tenantKey?: string;
}

export interface EmitResult {
  eventId: string;
  delivered: boolean;
  deliveryId: number;
  finalState: "succeeded" | "dead_lettered" | "pending";
  attempts: number;
}

function getSecret(): string | null {
  return process.env.ARCHISIGN_WEBHOOK_SECRET || null;
}

function buildHeaders(rawBody: string, tenantKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = getSecret();
  if (!secret) return headers;

  const v2Active = isV2Enabled(tenantKey);
  const ts = Date.now();

  if (v2Active) {
    const { header } = signV2(rawBody, secret, ts);
    headers["x-archisign-signature"] = header;
    headers[V2_TIMESTAMP_HEADER] = String(ts);
  } else {
    headers["x-archisign-signature"] = signV1(rawBody, secret);
  }
  return headers;
}

async function attemptDelivery(webhookUrl: string, body: string, headers: Record<string, string>): Promise<{ ok: boolean; statusCode: number | null; error: string | null; retryable: boolean }> {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) {
      return { ok: true, statusCode: response.status, error: null, retryable: false };
    }
    const retryable = response.status >= 500 || response.status === 429;
    return { ok: false, statusCode: response.status, error: `HTTP ${response.status} ${response.statusText}`, retryable };
  } catch (err: any) {
    return { ok: false, statusCode: null, error: err?.message || String(err), retryable: true };
  }
}

/**
 * Idempotent event emission with persistent ledger.
 *  - Records every attempt to webhook_deliveries (eventId-keyed unique)
 *  - Dual-emit: v1 by default, v2 when tenant is in ARCHISIGN_WEBHOOK_V2_TENANTS
 *  - 5 attempts, exponential backoff, 10s per-attempt timeout
 *  - Marks state as succeeded | dead_lettered when terminal
 */
export async function emitEvent(opts: EmitOptions): Promise<EmitResult> {
  const eventId = opts.eventId || uuidv7();
  const occurredAt = (opts.occurredAt || new Date()).toISOString();
  const event = opts.eventData.event;

  if (!CANONICAL_EVENTS.has(event)) {
    throw new Error(`Non-canonical event name on wire: ${event}`);
  }

  const common: CommonEnvelopeFields = {
    envelopeId: opts.envelope.id,
    externalRef: opts.envelope.externalRef ?? null,
    metadata: opts.metadata ?? null,
    occurredAt,
  };

  const payload = buildEventPayload(eventId, common, opts.eventData);
  const body = JSON.stringify(payload);

  // Race-tight idempotent claim: INSERT ... ON CONFLICT DO NOTHING.
  // Only the caller that wins the insert proceeds to dispatch; concurrent
  // emit_event calls with the same eventId observe an existing row and return
  // its current state without re-dispatching.
  const claimed = await storage.claimWebhookDelivery({
    eventId,
    envelopeId: opts.envelope.id,
    event,
    webhookUrl: opts.webhookUrl,
    payload: body,
    state: "pending",
    attempts: 0,
    lastError: null,
    lastStatusCode: null,
  });

  let delivery: WebhookDelivery;
  if (!claimed) {
    const existing = await storage.getWebhookDeliveryByEventId(eventId);
    if (!existing) {
      throw new Error(`emitEvent: claim raced but no row found for eventId ${eventId}`);
    }
    if (existing.state === "succeeded") {
      return { eventId, delivered: true, deliveryId: existing.id, finalState: "succeeded", attempts: existing.attempts };
    }
    if (existing.state === "dead_lettered") {
      return { eventId, delivered: false, deliveryId: existing.id, finalState: "dead_lettered", attempts: existing.attempts };
    }
    // Another caller is currently dispatching this eventId; do not duplicate.
    return { eventId, delivered: false, deliveryId: existing.id, finalState: "pending", attempts: existing.attempts };
  }
  delivery = claimed;

  let lastResult: { statusCode: number | null; error: string | null } = { statusCode: null, error: null };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Headers built per attempt so v2 timestamp is fresh (replay window 5min).
    const headers = buildHeaders(body, opts.tenantKey);
    const result = await attemptDelivery(opts.webhookUrl, body, headers);
    lastResult = { statusCode: result.statusCode, error: result.error };

    if (result.ok) {
      await storage.markWebhookDeliveryAttempt(delivery.id, result.statusCode, null);
      const succeeded = await storage.markWebhookDeliverySucceeded(delivery.id, result.statusCode!);
      return { eventId, delivered: true, deliveryId: delivery.id, finalState: "succeeded", attempts: succeeded?.attempts ?? attempt };
    }

    await storage.markWebhookDeliveryAttempt(delivery.id, result.statusCode, result.error);

    if (!result.retryable) {
      console.error(`[EventDispatcher] Non-retryable ${result.statusCode} from ${opts.webhookUrl} (event=${event} eventId=${eventId})`);
      const dead = await storage.markWebhookDeliveryDeadLettered(delivery.id, result.error || `non-retryable ${result.statusCode}`);
      return { eventId, delivered: false, deliveryId: delivery.id, finalState: "dead_lettered", attempts: dead?.attempts ?? attempt };
    }

    if (attempt < MAX_ATTEMPTS) {
      const delay = BACKOFF_MS[attempt - 1] ?? 30_000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  console.error(`[EventDispatcher] All ${MAX_ATTEMPTS} attempts exhausted for ${opts.webhookUrl} (event=${event} eventId=${eventId})`);
  const dead = await storage.markWebhookDeliveryDeadLettered(delivery.id, lastResult.error || "max attempts exhausted");
  return { eventId, delivered: false, deliveryId: delivery.id, finalState: "dead_lettered", attempts: dead?.attempts ?? MAX_ATTEMPTS };
}

/**
 * Operator-triggered manual retry of a dead-lettered delivery.
 * Resets state to pending and re-runs the dispatch loop with the persisted payload.
 */
export async function retryDeadLettered(deliveryId: number, tenantKey?: string): Promise<EmitResult | null> {
  const existing = await storage.getWebhookDelivery(deliveryId);
  if (!existing) return null;
  if (existing.state !== "dead_lettered") {
    throw new Error(`Cannot retry delivery in state ${existing.state}; only dead_lettered is retryable`);
  }
  await storage.resetDeliveryForRetry(deliveryId);

  const body = existing.payload;
  let lastResult: { statusCode: number | null; error: string | null } = { statusCode: null, error: null };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const headers = buildHeaders(body, tenantKey);
    const result = await attemptDelivery(existing.webhookUrl, body, headers);
    lastResult = { statusCode: result.statusCode, error: result.error };

    if (result.ok) {
      await storage.markWebhookDeliveryAttempt(existing.id, result.statusCode, null);
      const succeeded = await storage.markWebhookDeliverySucceeded(existing.id, result.statusCode!);
      return { eventId: existing.eventId, delivered: true, deliveryId: existing.id, finalState: "succeeded", attempts: succeeded?.attempts ?? attempt };
    }

    await storage.markWebhookDeliveryAttempt(existing.id, result.statusCode, result.error);

    if (!result.retryable) {
      const dead = await storage.markWebhookDeliveryDeadLettered(existing.id, result.error || `non-retryable ${result.statusCode}`);
      return { eventId: existing.eventId, delivered: false, deliveryId: existing.id, finalState: "dead_lettered", attempts: dead?.attempts ?? attempt };
    }

    if (attempt < MAX_ATTEMPTS) {
      const delay = BACKOFF_MS[attempt - 1] ?? 30_000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  const dead = await storage.markWebhookDeliveryDeadLettered(existing.id, lastResult.error || "max attempts exhausted");
  return { eventId: existing.eventId, delivered: false, deliveryId: existing.id, finalState: "dead_lettered", attempts: dead?.attempts ?? MAX_ATTEMPTS };
}
