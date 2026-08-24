import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { envelopes } from "@shared/schema";
import { db } from "../../db";
import { storage } from "../../storage";

test("atomic send claim enforces the current Archie Doc placement revision", async () => {
  const envelope = await storage.createEnvelope({
    subject: `Placement gate ${randomUUID()}`,
    status: "draft",
    origin: "archidoc",
    originalPdfUrl: "/uploads/placement-gate.pdf",
    placementReviewState: "review_required",
    placementConfidence: "low",
    placementReasons: JSON.stringify([
      { code: "signer_anchor_missing", message: "A signer-specific anchor was missing." },
    ]),
    placementRevision: 1,
  });

  try {
    assert.equal(await storage.atomicClaimEnvelopeSend(envelope.id, new Date()), null);

    await storage.updateEnvelope(envelope.id, {
      placementReviewState: "ready",
      placementConfidence: "high",
    });
    assert.ok(await storage.atomicClaimEnvelopeSend(envelope.id, new Date()));

    await storage.updateEnvelope(envelope.id, {
      status: "draft",
      placementReviewState: "approved",
      placementRevision: 2,
      placementApprovedRevision: 1,
    });
    assert.equal(await storage.atomicClaimEnvelopeSend(envelope.id, new Date()), null);

    await storage.updateEnvelope(envelope.id, { placementApprovedRevision: 2 });
    assert.ok(await storage.atomicClaimEnvelopeSend(envelope.id, new Date()));
  } finally {
    await db.delete(envelopes).where(eq(envelopes.id, envelope.id));
  }
});

test("a locked placement mutation commits review-required before a concurrent send can claim", async () => {
  const envelope = await storage.createEnvelope({
    subject: `Placement mutation race ${randomUUID()}`,
    status: "draft",
    origin: "archidoc",
    originalPdfUrl: "/uploads/placement-race.pdf",
    placementReviewState: "ready",
    placementConfidence: "high",
    placementRevision: 0,
  });

  let releaseMutation!: () => void;
  const mutationMayCommit = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  let reportLockAcquired!: () => void;
  const lockAcquired = new Promise<void>((resolve) => {
    reportLockAcquired = resolve;
  });

  try {
    const mutation = db.transaction(async (tx) => {
      const locked = await storage.getEnvelopeForUpdate(envelope.id, tx);
      assert.ok(locked);
      reportLockAcquired();
      await mutationMayCommit;
      await storage.updateEnvelope(envelope.id, {
        placementReviewState: "review_required",
        placementRevision: locked.placementRevision + 1,
      }, tx);
    });

    await lockAcquired;
    const sendClaim = storage.atomicClaimEnvelopeSend(envelope.id, new Date());
    const earlyResult = await Promise.race([
      sendClaim.then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
    ]);
    assert.equal(earlyResult, "waiting");

    releaseMutation();
    await mutation;
    assert.equal(await sendClaim, null);
  } finally {
    releaseMutation();
    await db.delete(envelopes).where(eq(envelopes.id, envelope.id));
  }
});