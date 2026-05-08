/**
 * Task #19 — One-shot reconciliation for envelope 22's two ledger gaps.
 *
 * Background:
 *  - Delivery row #1 (envelope.queried, eventId 019e02ae-...-b2a0) is stuck
 *    in `dead_lettered` even though the receiver acknowledged out-of-band.
 *  - The synthesised envelope.signed event (eventId 019e063b-b5a3-73a7-a363-
 *    6589ad7094ae) was relayed manually but no row was ever written to the
 *    ledger — so AS5 hygiene + operator retry tooling can't see it.
 *
 * This script is fully idempotent:
 *   - mark-succeeded only flips state if currently dead_lettered.
 *   - synthesised insert is gated on eventId UNIQUE — re-runs no-op.
 *
 * Run once:  npx tsx scripts/reconcile-envelope-22.ts
 */
import { db } from "../server/db";
import { webhookDeliveries, envelopes } from "@shared/schema";
import { eq } from "drizzle-orm";

const ENVELOPE_ID = 22;
const QUERIED_EVENT_ID = "019e02ae-0000-0000-0000-00000000b2a0";
const SIGNED_EVENT_ID = "019e063b-b5a3-73a7-a363-6589ad7094ae";

async function main() {
  const env = await db.query.envelopes.findFirst({ where: eq(envelopes.id, ENVELOPE_ID) });
  if (!env) {
    console.error(`Envelope ${ENVELOPE_ID} not found — aborting.`);
    process.exit(1);
  }
  if (!env.webhookUrl) {
    console.error(`Envelope ${ENVELOPE_ID} has no webhookUrl — cannot reconcile.`);
    process.exit(1);
  }

  // 1) Flip the dead_lettered queried delivery to succeeded.
  const queried = await db.query.webhookDeliveries.findFirst({
    where: eq(webhookDeliveries.eventId, QUERIED_EVENT_ID),
  });
  if (!queried) {
    console.warn(`No delivery row for queried event ${QUERIED_EVENT_ID} — skipping flip.`);
  } else if (queried.state === "succeeded") {
    console.log(`Queried delivery #${queried.id} already succeeded — no change.`);
  } else if (queried.state !== "dead_lettered") {
    console.warn(`Queried delivery #${queried.id} in unexpected state '${queried.state}' (expected dead_lettered) — refusing to flip; investigate manually.`);
  } else {
    const now = new Date();
    await db.update(webhookDeliveries)
      .set({
        state: "succeeded",
        succeededAt: now,
        deadLetteredAt: null,
        lastError: `${queried.lastError ?? ""}\n[reconcile] receiver confirmed out-of-band ${now.toISOString()}`.trim(),
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, queried.id));
    console.log(`Queried delivery #${queried.id} (eventId ${QUERIED_EVENT_ID}) flipped → succeeded.`);
  }

  // 2) Insert the synthesised signed-event ledger row if missing.
  const existingSigned = await db.query.webhookDeliveries.findFirst({
    where: eq(webhookDeliveries.eventId, SIGNED_EVENT_ID),
  });
  if (existingSigned) {
    console.log(`Signed delivery #${existingSigned.id} already in ledger (state=${existingSigned.state}) — no change.`);
  } else {
    const now = new Date();
    const SENTINEL = "unavailable_pre_capture";
    // Match §3.3 envelope.signed shape exactly so downstream tooling that
    // replays from the ledger sees a canonical payload. Identity fields use
    // the documented sentinel because the original sign action predates
    // identity-trail capture.
    const payload = JSON.stringify({
      eventId: SIGNED_EVENT_ID,
      event: "envelope.signed",
      envelopeId: ENVELOPE_ID,
      externalRef: env.externalRef ?? null,
      metadata: { _reconciliation: "Task #19 — synthesised post-hoc; receiver acknowledged out-of-band.", recordedAt: now.toISOString() },
      occurredAt: now.toISOString(),
      signedAt: SENTINEL,
      signedPdfFetchUrl: SENTINEL,
      signedPdfFetchUrlExpiresAt: SENTINEL,
      identityVerification: {
        method: "otp_email",
        otpIssuedAt: SENTINEL,
        otpVerifiedAt: SENTINEL,
        signerIpAddress: SENTINEL,
        signerUserAgent: SENTINEL,
        lastViewedAt: SENTINEL,
        signedAt: SENTINEL,
        authenticationId: `envelope:${ENVELOPE_ID}:reconciliation`,
      },
    });
    const inserted = await db.insert(webhookDeliveries).values({
      eventId: SIGNED_EVENT_ID,
      envelopeId: ENVELOPE_ID,
      event: "envelope.signed",
      webhookUrl: env.webhookUrl,
      payload,
      state: "succeeded",
      attempts: 1,
      lastAttemptAt: now,
      lastStatusCode: 200,
      succeededAt: now,
    }).returning();
    console.log(`Synthesised signed delivery row #${inserted[0]?.id} inserted (eventId ${SIGNED_EVENT_ID}).`);
  }

  console.log("Reconciliation complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Reconciliation failed:", err);
    process.exit(1);
  });
