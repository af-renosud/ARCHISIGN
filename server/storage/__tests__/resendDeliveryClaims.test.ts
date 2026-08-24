import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { envelopes } from "@shared/schema";
import { db } from "../../db";
import { storage } from "../../storage";
import {
  RESEND_EMAIL_PROVIDER_TIMEOUT_MS,
} from "../../services/NotificationService";
import {
  RESEND_DELIVERY_CLAIM_TIMEOUT_MS,
} from "../../storage";

assert.ok(
  RESEND_EMAIL_PROVIDER_TIMEOUT_MS < RESEND_DELIVERY_CLAIM_TIMEOUT_MS,
  "provider timeout must stay below the abandoned-claim recovery window",
);

test("resend delivery claims and signing claims atomically exclude each other", async () => {
  const envelope = await storage.createEnvelope({
    subject: `Resend claim test ${randomUUID()}`,
    status: "sent",
    originalPdfUrl: "/uploads/resend-claim-test.pdf",
  });

  try {
    const signer = await storage.createSigner({
      envelopeId: envelope.id,
      email: `resend-claim-${randomUUID()}@example.test`,
      fullName: "Resend Claim Test",
      accessToken: randomUUID(),
    });
    const deliveryClaimId = randomUUID();

    const deliveryClaim = await storage.atomicClaimResendDelivery(signer.id, deliveryClaimId);
    assert.equal(deliveryClaim?.resendDeliveryClaimId, deliveryClaimId);

    const signWhileDelivering = await storage.atomicClaimSign(signer.id);
    assert.equal(signWhileDelivering, undefined);

    await storage.releaseResendDeliveryClaim(signer.id, deliveryClaimId);
    const signed = await storage.atomicClaimSign(signer.id);
    assert.ok(signed?.signedAt);

    const deliveryAfterSigning = await storage.atomicClaimResendDelivery(signer.id, randomUUID());
    assert.equal(deliveryAfterSigning, undefined);

    const staleClaimId = randomUUID();
    const staleSigner = await storage.createSigner({
      envelopeId: envelope.id,
      email: `stale-resend-claim-${randomUUID()}@example.test`,
      fullName: "Stale Resend Claim Test",
      accessToken: randomUUID(),
      resendDeliveryClaimId: staleClaimId,
      resendDeliveryClaimedAt: new Date(0),
    });
    assert.equal(await storage.refreshResendDeliveryClaim(staleSigner.id, staleClaimId), true);
    assert.equal(await storage.atomicClaimSign(staleSigner.id), undefined);
    await storage.updateSigner(staleSigner.id, { resendDeliveryClaimedAt: new Date(0) });
    const signedAfterStaleClaim = await storage.atomicClaimSign(staleSigner.id);
    assert.ok(signedAfterStaleClaim?.signedAt);
    assert.equal(signedAfterStaleClaim?.resendDeliveryClaimId, null);
  } finally {
    await db.delete(envelopes).where(eq(envelopes.id, envelope.id));
  }
});