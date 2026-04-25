import { storage } from "../storage";
import { emitEvent } from "../services/EventDispatcher";
import { fileExists } from "../fileStorage";
import { log } from "../index";

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const STARTUP_DELAY_MS = 30_000;

const EXPIRY_INTERVAL_MS = ONE_HOUR_MS;
const INTEGRITY_INTERVAL_MS = ONE_DAY_MS;
const INTEGRITY_PAGE_SIZE = 200;

let started = false;
const timers: NodeJS.Timeout[] = [];

/**
 * Inter-App Contract v1.0 §3.5.4 + §3.8 — periodic vault hygiene.
 *
 *  1. expiresAt sweeper: every hour, atomically transitions any envelope past
 *     its `expiresAt` to status='expired' and emits a single
 *     `envelope.expired` webhook per envelope.
 *
 *  2. retention integrity check: walks all retained signed envelopes, verifies
 *     the signed PDF object is still retrievable, marks unrecoverable rows
 *     with `retention_breach_at` and emits a single `envelope.retention_breach`.
 *     Idempotent — only operates on envelopes not already breached, so the
 *     webhook fires exactly once per envelope per the §3.7 rule.
 */
export function startSchedulers(): void {
  if (started) return;
  started = true;

  if (process.env.ARCHISIGN_DISABLE_SCHEDULERS === "1") {
    log("Schedulers disabled via ARCHISIGN_DISABLE_SCHEDULERS=1", "scheduler");
    return;
  }

  // Stagger startup so neither job runs during boot/crash loops.
  timers.push(setTimeout(() => {
    runExpirySweep().catch(err => log(`expirySweep error: ${err?.message || err}`, "scheduler"));
    timers.push(setInterval(() => {
      runExpirySweep().catch(err => log(`expirySweep error: ${err?.message || err}`, "scheduler"));
    }, EXPIRY_INTERVAL_MS).unref());
  }, STARTUP_DELAY_MS).unref());

  timers.push(setTimeout(() => {
    runIntegrityCheck().catch(err => log(`integrityCheck error: ${err?.message || err}`, "scheduler"));
    timers.push(setInterval(() => {
      runIntegrityCheck().catch(err => log(`integrityCheck error: ${err?.message || err}`, "scheduler"));
    }, INTEGRITY_INTERVAL_MS).unref());
  }, STARTUP_DELAY_MS * 2).unref());

  log("Schedulers started: expirySweep hourly, integrityCheck daily", "scheduler");
}

export function stopSchedulers(): void {
  for (const t of timers) {
    clearTimeout(t);
    clearInterval(t);
  }
  timers.length = 0;
  started = false;
}

export async function runExpirySweep(): Promise<{ expired: number; emitted: number }> {
  const now = new Date();
  const expired = await storage.markEnvelopeExpiredAtomic(now);
  if (expired.length === 0) {
    return { expired: 0, emitted: 0 };
  }
  log(`expirySweep: ${expired.length} envelope(s) past expiresAt`, "scheduler");

  let emitted = 0;
  for (const env of expired) {
    if (!env.webhookUrl) {
      await storage.createAuditEvent({
        envelopeId: env.id,
        eventType: "Envelope expired (no webhook)",
        actorEmail: null,
        ipAddress: null,
        metadata: JSON.stringify({ expiredAt: now.toISOString() }),
      }).catch(() => {});
      continue;
    }
    // Per §3.3 envelope.expired.expiredAt is the original `expiresAt` value
    // set at create-time, NOT the sweep timestamp.
    const originalExpiresAt = env.expiresAt instanceof Date
      ? env.expiresAt.toISOString()
      : env.expiresAt
        ? new Date(env.expiresAt).toISOString()
        : now.toISOString();
    try {
      const result = await emitEvent({
        webhookUrl: env.webhookUrl,
        envelope: { id: env.id, externalRef: env.externalRef, origin: env.origin },
        eventData: {
          event: "envelope.expired",
          expiredAt: originalExpiresAt,
        },
        occurredAt: now,
        tenantKey: env.origin || undefined,
      });
      if (result.delivered) emitted++;
      await storage.createAuditEvent({
        envelopeId: env.id,
        eventType: result.delivered ? "Envelope expired — webhook delivered" : "Envelope expired — webhook dead-lettered",
        actorEmail: null,
        ipAddress: null,
        metadata: JSON.stringify({ eventId: result.eventId, attempts: result.attempts, finalState: result.finalState }),
      }).catch(() => {});
    } catch (err: any) {
      log(`expirySweep emit failure for envelope ${env.id}: ${err?.message || err}`, "scheduler");
    }
  }

  log(`expirySweep complete: ${emitted}/${expired.length} webhooks delivered`, "scheduler");
  return { expired: expired.length, emitted };
}

export async function runIntegrityCheck(): Promise<{ scanned: number; breached: number }> {
  let scanned = 0;
  let breached = 0;
  let offset = 0;

  for (;;) {
    const batch = await storage.getEnvelopesForIntegrityCheck(INTEGRITY_PAGE_SIZE, offset);
    if (batch.length === 0) break;

    for (const env of batch) {
      scanned++;
      if (!env.signedPdfUrl) continue;

      let exists = false;
      try {
        exists = await fileExists(env.signedPdfUrl);
      } catch (err: any) {
        log(`integrityCheck file probe error for envelope ${env.id}: ${err?.message || err}`, "scheduler");
        continue;
      }

      if (exists) continue;

      const detectedAt = new Date();
      const incidentRef = `INC-${detectedAt.getUTCFullYear()}-${String(env.id).padStart(6, "0")}`;
      const updated = await storage.markEnvelopeRetentionBreach(env.id, incidentRef, detectedAt);
      if (!updated) continue;
      breached++;

      log(`integrityCheck: envelope ${env.id} retention breach (${incidentRef})`, "scheduler");

      // Per §3.3 envelope.retention_breach.originalSignedAt is the actual
      // signing timestamp. We pull the latest `signedAt` across signers as the
      // authoritative time the envelope was sealed.
      const envWithSigners = await storage.getEnvelope(env.id);
      const signedAtCandidates = (envWithSigners?.signers ?? [])
        .map(s => s.signedAt)
        .filter((d): d is Date => !!d);
      const originalSignedAt = signedAtCandidates.length > 0
        ? new Date(Math.max(...signedAtCandidates.map(d => (d instanceof Date ? d.getTime() : new Date(d).getTime())))).toISOString()
        : (env.updatedAt instanceof Date ? env.updatedAt : new Date(env.updatedAt)).toISOString();

      if (env.webhookUrl) {
        try {
          const result = await emitEvent({
            webhookUrl: env.webhookUrl,
            envelope: { id: env.id, externalRef: env.externalRef, origin: env.origin },
            eventData: {
              event: "envelope.retention_breach",
              originalSignedAt,
              detectedAt: detectedAt.toISOString(),
              incidentRef,
              remediationContact: process.env.ARCHISIGN_RETENTION_REMEDIATION_CONTACT || "vault-ops@archisign.fr",
            },
            occurredAt: detectedAt,
            tenantKey: env.origin || undefined,
          });
          await storage.createAuditEvent({
            envelopeId: env.id,
            eventType: result.delivered ? "Retention breach detected — webhook delivered" : "Retention breach detected — webhook dead-lettered",
            actorEmail: null,
            ipAddress: null,
            metadata: JSON.stringify({ eventId: result.eventId, incidentRef, attempts: result.attempts, finalState: result.finalState }),
          }).catch(() => {});
        } catch (err: any) {
          log(`integrityCheck emit failure for envelope ${env.id}: ${err?.message || err}`, "scheduler");
        }
      } else {
        await storage.createAuditEvent({
          envelopeId: env.id,
          eventType: "Retention breach detected (no webhook)",
          actorEmail: null,
          ipAddress: null,
          metadata: JSON.stringify({ incidentRef, detectedAt: detectedAt.toISOString() }),
        }).catch(() => {});
      }
    }

    if (batch.length < INTEGRITY_PAGE_SIZE) break;
    offset += INTEGRITY_PAGE_SIZE;
  }

  if (scanned > 0 || breached > 0) {
    log(`integrityCheck complete: ${scanned} scanned, ${breached} breached`, "scheduler");
  }
  return { scanned, breached };
}
