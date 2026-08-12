---
name: Custom agent DNS lookup contract
description: Custom `lookup` on http/https Agents must honor `{ all: true }` (Node 20+ autoSelectFamily) or connections fail with "Invalid IP address: undefined".
---

Any custom `lookup` function passed to an `http.Agent`/`https.Agent` (e.g. the SSRF guard) must support BOTH callback shapes:
- legacy: `callback(err, addressString, family)`
- `{ all: true }` in options: `callback(err, [{ address, family }, ...])`

**Why:** Node 20+'s `autoSelectFamily` connection path (default on) calls lookup with `{ all: true }`. Returning a bare string then makes Node's internal address validation throw `Invalid IP address: undefined`. In production this surfaced as 503 `vault_transient` on the partner envelope-creation API whenever `pdfFetchUrl` was used — and looked misleadingly like a client-IP/trust-proxy problem.

**How to apply:** when adding or modifying any pinned-DNS/SSRF lookup, validate ALL resolved A+AAAA addresses against private ranges, then return the full validated array under `all: true` (safe: every candidate was checked). Tests must cover both shapes. Diagnostic hint: "Invalid IP address: undefined" from an outbound fetch almost always means a lookup-shape mismatch, not a request-IP issue.
