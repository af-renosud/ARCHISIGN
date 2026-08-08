---
name: Continuation envelopes
description: Design invariants for "send a signed document on for further signature"
---

Signed envelopes are immutable evidence — never reopen one. A continuation is a NEW draft envelope copied from the parent's signed PDF, linked via parentEnvelopeId + parentDocumentHash + continuationSequence.

**Why:** audit trail, certificate, integrity hash and webhook history of a signed envelope must stay intact; partner apps (API-origin) treat the first envelope.signed event as terminal, so API-origin parents are rejected 409 until the inter-app contract is amended.

**How to apply:**
- Strip the parent's trailing certificate pages (marker `archisign-cert-v1:<N>` in PDF keywords) before using its signed PDF as a child's working document — otherwise fields could land on cert pages that re-stamping silently drops.
- parentDocumentHash must never be null: for legacy signed parents without documentHash, hash the exact copied artifact (sha256 of the full stored signed PDF).
- Any upload that precedes a DB transaction needs compensating deleteFile on transaction failure.
