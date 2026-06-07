# Archisign Threat Model

## Scope and deployment assumptions
- Production deployment is public on an autoscale Replit deployment.
- Only production-reachable code paths are in scope. Dev/test-only paths such as `E2E_AUTH_BYPASS`, Playwright harnesses, one-off scripts, and mockup sandbox behavior are out of scope unless production reachability is demonstrated.
- TLS is provided by the platform.
- Secrets are expected to be supplied through Replit Secrets.
- The application is a document-signing system handling sensitive PDFs, signer identity evidence, audit trails, and partner-to-partner integrations.

## Assets
- Original and signed PDFs in object storage
- Signer access tokens and OTP verification state
- Admin sessions and Google Workspace identity
- API keys for ArchiDoc and Architrak
- Audit trail and identity verification metadata
- Outbound webhook destinations and signed PDF fetch URLs

## Actors
- Public internet attacker with no credentials
- External signer holding a signing link
- Authenticated admin from the allowed Google Workspace
- Partner systems authenticated with `X-API-KEY`
- Replit-hosted platform services and object storage

## Trust boundaries
1. Public HTTP boundary: unauthenticated requests to `/sign/*`, `/api/sign/*`, `/api/v1/envelopes/:id/signed-pdf-fetch`, and `/uploads/*`.
2. Admin boundary: session-authenticated `/api/*` routes guarded by Google Workspace OAuth and domain/allowlist checks.
3. Partner boundary: API-key-authenticated `/api/v1/*` routes for ArchiDoc and Architrak.
4. Storage boundary: private object storage paths exposed indirectly through application routes.
5. External network boundary: Gmail API, webhook delivery targets, and PDF fetch URLs supplied by integration callers.

## Key attack surfaces
- Signer authentication flow: token validation, OTP issuance, OTP verification, document access, final signing
- File handling and file serving: original PDFs, signed PDFs, backups, and object storage path exposure
- Partner API: envelope create/send/read flows, signed PDF URL minting, tenant separation, idempotency, rate limiting
- Admin auth and session enforcement
- Outbound webhooks and signed URL minting

## Production-scope notes
- `/api/sign/:token/*` is intentionally public but must preserve document confidentiality and resist guessing and brute force.
- `/api/v1/*` is exposed to partner systems and must enforce tenant isolation per API key, not merely authenticate that a caller has some valid key.
- Stored PDFs should be treated as confidential records even when signer or partner workflows exist to retrieve them.
- Autoscale means protections implemented only in process memory may not hold globally across instances.

## Out of scope for this scan
- Local-only developer tooling, CI scripts, and test helpers without a demonstrated production path
- Security improvements without an exploitable weakness
- Findings that require prior full compromise of infrastructure or secrets with no application-layer weakness

## Scan anchors
- `server/routes.ts`
- `server/routes/v1Envelopes.ts`
- `server/routes/v1Contacts.ts`
- `server/middleware/apiKeyAuth.ts`
- `server/middleware/rateLimit.ts`
- `server/fileStorage.ts`
- `server/storage.ts`
- `server/services/SecurityService.ts`
- `server/services/EventDispatcher.ts`
- `server/services/NotificationService.ts`
- `shared/schema.ts`
