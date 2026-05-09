# Archisign - E-Signature Platform

## Overview
Archisign is an internal tool for a French architecture firm (Maître d'Œuvre) to handle external sign-offs (clients, contractors, partners) for architectural plans and contracts. It integrates with Gmail for email communication and provides a secure, tokenised signing workflow with OTP verification and full audit trails.

See `ARCHISIGN_ARCHITECTURE.md` for enforced engineering standards, service boundaries, and AI agent directives.
See `ARCHITECTURE.md` for detailed system architecture, database schema, and API documentation.
See `docs/INTER_APP_CONTRACT_v1.0.md` for the frozen Inter-App Wire Contract (ArchiDoc / Architrak).

## Architecture
- **Frontend**: React + Vite + Tailwind CSS + Shadcn UI
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL (Replit-hosted, Drizzle ORM)
- **Email**: Gmail API via Replit Google Mail connector
- **PDF**: pdf-lib + @pdf-lib/fontkit (server-side stamp); pdfjs-dist (client-side guided-signing canvas render)
- **File Storage**: Replit Object Storage (GCS-backed, persistent across deploys)
- **Auth**: Replit Auth (OIDC) for admin, Token+OTP for external signers

## Key Features
1. **Admin Dashboard** — table of all envelopes with filtering by status, client, reference (10s auto-refresh)
2. **Envelope Management** — create, send, track document sign-off workflows
3. **Admin Field Editor** — drag-and-drop placement of signature/initial/date fields on each page (guided + free modes, undo/redo)
4. **External Signer Interface** — tokenised URL, OTP verification, page-by-page initials on a locked single-page canvas, final signature
5. **Query Loop** — signers can request clarification, triggering Gmail threads
6. **ArchiDoc / Architrak v1.0 API** — `POST /api/v1/envelopes/create`, `/send`, `/signed-pdf-url` with API-key auth, per-tenant rate limiting, idempotent dispatch
7. **Webhook Callbacks** — HMAC SHA-256 (v1) + per-§3.9 timestamp-prefixed v2 dual-emit, persisted in `webhook_deliveries` ledger with exponential backoff retries
8. **Settings Page** — admin-editable email copy text stored in DB

## Database Schema
- `envelopes` — Documents sent for signing (soft-delete via `deleted_at`)
  - v1.0 contract columns: `expires_at`, `decline_reason`, `origin`, `retention_breach_at`, `retention_incident_ref`, `retention_detected_at`
  - status enum includes terminal lifecycle states `expired` and `void`
- `signers` — External parties (token + OTP auth)
  - v1.0 contract columns: `otp_issued_at`, `otp_verified_at`, `signer_ip_address`, `signer_user_agent`, `access_token_rotated_at`, `previous_access_token_hash`
- `annotations` — Initials/signatures per page (signerId FK, xPos, yPos, width, height, type, value, placed)
- `communication_logs` — Query messages between parties
- `audit_events` — Full audit trail (nullable envelopeId for system events)
- `webhook_deliveries` — Outbound dispatch ledger (eventId UUID idempotency key, state pending/succeeded/dead_lettered, attempts counter, raw payload + signature audit trail)
- `settings` — Key-value configuration (email copy text, firm name, etc.)
- `rollback_versions` — Version tracking ledger
- `backups` — Backup file metadata
- `users` / `sessions` — Replit Auth (OIDC) admin accounts + connect-pg-simple session storage

## Inter-App Wire Contract v1.0 (frozen 2026-04-25)
Authoritative spec: `docs/INTER_APP_CONTRACT_v1.0.md`. Five-task delivery (AS1 → AS2 → {AS3, AS4} → AS5) is fully landed:
- Schema foundation (enums, columns, ledger table, IStorage methods)
- API key middleware (ARCHIDOC + ARCHITRAK), per-(key, family) rate limit (60 RPM / 30 burst / 5000 day), v1 + v2 HMAC signing
- Event dispatcher with idempotent `webhook_deliveries` ledger; 7 canonical events; v1+v2 dual-emit gated by `ARCHISIGN_WEBHOOK_V2_TENANTS` (default-on with opt-out via `ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS`)
- v1 endpoints: `pdfFetchUrl` ingestion, `/send` Idempotency-Key, `/signed-pdf-url` re-mint with §3.8 410 retention_breach response, signed-pdf-fetch HMAC URL (15 min TTL)
- Background schedulers: hourly `expirySweep` (atomic transition to `expired` + `envelope.expired` event); daily `integrityCheck` (signed-PDF probe → `retention_breach_at` + `envelope.retention_breach`)

## Project Structure
```
client/src/
  pages/dashboard.tsx              - Admin dashboard (10s auto-refresh)
  pages/envelope-new.tsx           - Create envelope (PDF upload + signers)
  pages/envelope-detail.tsx        - Envelope detail tabs (overview, signers, communication, audit)
  pages/envelope-field-editor.tsx  - Admin drag-and-drop field placement (signature, initial, date) with undo/redo
  pages/signer-verify.tsx          - External OTP verification
  pages/signer-document.tsx        - Guided signing flow: pre-Start review iframe + locked single-page wizard
  pages/settings.tsx               - Admin settings (email copy text, firm name)
  pages/rollback-ledger.tsx        - Rollback version ledger
  pages/data-recovery.tsx          - Deleted envelopes + backup management
  pages/pre-deployment.tsx         - Pre-deployment audit prompts
  pages/login.tsx                  - Split-screen login (Replit Auth)
  components/locked-page-view.tsx  - pdfjs-dist canvas render with on-page initial/signature placeholders
  components/app-sidebar.tsx       - Navigation sidebar
  components/theme-toggle.tsx      - Dark/light mode

server/
  index.ts                         - Express setup (25MB JSON limit, graceful shutdown, scheduler boot, v2 allowlist validation)
  routes.ts                        - Admin + signer-token routes (admin protected by auth middleware)
  routes/v1Envelopes.ts            - v1.0 wire contract endpoints (apiKeyAuth + rateLimit mounted on router)
  storage.ts                       - IStorage data access layer
  fileStorage.ts                   - Object Storage abstraction (upload/download/stream/delete PDFs & backups)
  db.ts                            - Drizzle/PostgreSQL connection
  gmail.ts                         - Gmail API integration
  seed.ts                          - Email settings seeder
  jobs/scheduler.ts                - expirySweep + integrityCheck background jobs
  middleware/asyncHandler.ts       - Async route wrapper
  middleware/validators.ts         - Route param validators
  middleware/apiKeyAuth.ts         - X-API-KEY → tenant resolution
  middleware/rateLimit.ts          - Per-(tenant, family) token bucket
  services/PdfService.ts           - pdf-lib stamping (authoritative coordinate system)
  services/SecurityService.ts      - Crypto primitives (tokens, OTP, signing links)
  services/NotificationService.ts  - Email templates + completion notifications
  services/WebhookSignature.ts     - v1/v2 HMAC sign + verify; v2 tenant allowlist parser
  services/EventDispatcher.ts      - 7-event idempotent dispatch via webhook_deliveries ledger

shared/
  schema.ts        - Drizzle models + Zod schemas + relations
  models/auth.ts   - Users + sessions tables (Replit Auth)
```

## Authentication & Authorization
- **Replit Auth (OIDC)**: Admin area protected by OpenID Connect (Google, GitHub, Apple, email/password)
- **Admin Middleware**: All `/api/*` routes require auth EXCEPT `/api/sign/:token/*` and `/api/v1/*`
- **User Allowlist**: Optional `ADMIN_EMAILS` env var (comma-separated)
- **API Key Auth**: `/api/v1/*` validated by `apiKeyAuth` middleware against CSV lists in `ARCHIDOC_API_KEY` / `ARCHITRAK_API_KEY`; attaches `req.apiKeyAuth = {tenant, keyHash}`
- **Session Storage**: PostgreSQL-backed sessions (connect-pg-simple), 7-day TTL
- **Auth Audit**: Unauthorised access attempts logged to `audit_events`

## ArchiDoc / Architrak v1.0 API
- `POST /api/v1/envelopes/create` — accepts `pdfBase64`, `pdfUrl`, or `pdfFetchUrl` (60s budget, 25 MiB cap); `signers[]` array; optional `expiresAt`, `metadata`, `fields[]`, `identityVerification.method`; returns §3.5.1 shape with `signers[].accessUrl` + `otpDestination`
- `POST /api/v1/envelopes/:id/send` — idempotent on `{sent, viewed, queried}` (200); rejects terminal `{signed, declined, expired, void}` with 409
- `GET /api/v1/envelopes/:id/signed-pdf-url` — mints 15-min HMAC URL; returns 410 + §3.8 `retention_breach` body when breached
- `GET /api/v1/envelopes/:id/signed-pdf-fetch?exp=…&sig=…` — streams the PDF when HMAC matches
- Rate limit body matches §3.6.1 (`error`, `retryAfter`, `limit`, `currentUsage`, `ceiling`); `X-RateLimit-Remaining` set on 200s
- Body limit: 25MB JSON for large architectural PDFs
- Orphan cleanup: if DB transaction fails after PDF save, the saved file is deleted from Object Storage

## File Storage (Object Storage)
- All PDFs and backups stored in Replit Object Storage (GCS-backed, persistent across deploys)
- `fileStorage.ts` abstraction: `uploadFile`, `downloadFile`, `streamFileToResponse`, `fileExists`, `deleteFile`, `uploadBackup`, `downloadBackup`, `deleteBackupFile`
- Upload flow: Multer temp file → read buffer → upload → delete temp file (in `finally`)
- Serving flow: `/uploads/:filename` streams directly from Object Storage (no full-file buffering)
- Path traversal protection: filename validated — `..` and `/` segments rejected
- Layout: `<bucket>/<prefix>/uploads/` for PDFs, `<bucket>/<prefix>/backups/` for backup exports

## Security & Integrity Posture
- Path traversal hardening on all filename inputs
- OTP stored as SHA-256 hash; verification is timing-safe
- ACID transactions for envelope/signer creation; atomic double-sign prevention via conditional UPDATE
- Zod schema validation on all inbound payloads
- HMAC SHA-256 webhook payload signing (v1 `x-archisign-signature`); v2 `${ts}.${rawBody}` per §3.9 dual-emitted to allowlisted tenants
- Length-guarded `timingSafeEqual` on all HMAC verifies
- Webhook delivery: 5 attempts, exponential backoff `[1s, 3s, 10s, 30s]`, 10s per-attempt timeout, non-retryable 4xx (except 429) → `dead_lettered`
- Graceful shutdown drains in-flight requests
- Email-failure-safe send flow (DB state + audit recorded before email dispatch)
- Log sanitisation: tokens / OTPs / API keys redacted

## Guided Signing Flow (signer UX)
- Pre-Start screen renders the PDF in the browser's native viewer for free-form review
- After `Start`, the per-page wizard locks each page to a single anchored pdfjs-dist canvas render — no toolbar, sidebar, zoom controls, or scroll between pages
- Admin-placed initial/signature fields render as on-page placeholders (orange dashed) → placed markers (Dancing Script for signatures, initials text for initials) at the same coordinates `PdfService.stampSignedPdf` uses
- Fixed-bottom signature mode projects exact PDF-point geometry (260pt × ~96pt, centred, 10mm bottom padding) into rendered CSS pixels so the on-screen preview matches the stamped output

## Environment Variables & Secrets
| Variable                                | Type   | Required    | Description                                                                 |
|-----------------------------------------|--------|-------------|-----------------------------------------------------------------------------|
| DATABASE_URL                            | env    | Yes         | PostgreSQL connection string (auto-provided)                                |
| ARCHIDOC_API_KEY                        | secret | Yes         | CSV of API keys for ArchiDoc tenant (X-API-KEY)                             |
| ARCHITRAK_API_KEY                       | secret | No          | CSV of API keys for Architrak tenant (X-API-KEY)                            |
| ARCHISIGN_WEBHOOK_SECRET                | secret | No          | HMAC secret for v1+v2 webhook payload signing                               |
| ARCHISIGN_WEBHOOK_V2_TENANTS            | env    | No (legacy) | CSV or JSON-map allowlist override. When set, ONLY listed tenants get v2.   |
| ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS   | env    | No          | CSV opt-out list (consulted only when the legacy allowlist is unset)        |
| ARCHISIGN_SIGNED_URL_SECRET             | secret | No          | HMAC secret for /signed-pdf-fetch URLs (15-min TTL); falls back to ARCHISIGN_WEBHOOK_SECRET |
| ARCHISIGN_RETENTION_REMEDIATION_CONTACT | env    | No          | Email returned in 410 retention_breach + retention_breach event body        |
| ARCHISIGN_DISABLE_SCHEDULERS            | env    | No          | Set to "1" to disable expirySweep + integrityCheck (test/CI)                |
| ADMIN_EMAILS                            | env    | No          | Comma-separated allowlist of admin emails                                   |
| DEFAULT_OBJECT_STORAGE_BUCKET_ID        | secret | Auto        | Object Storage bucket ID                                                    |
| PRIVATE_OBJECT_DIR                      | secret | Auto        | Object Storage private directory path                                       |
| PUBLIC_OBJECT_SEARCH_PATHS              | secret | Auto        | Object Storage public search paths                                          |
| SESSION_SECRET                          | secret | Auto        | Express session secret                                                      |

## Recent Changes
- 2026-05-08: **Locked guided-signing wizard** — replaced native-PDF iframe in the per-page wizard with `LockedPageView` (pdfjs-dist canvas, DPR-aware, no toolbar/sidebar/scroll). Admin-placed initial/signature fields render as on-page orange-dashed placeholders → Dancing-Script-rendered placed markers at the same coordinates `PdfService.stampSignedPdf` uses. Fixed-bottom-centre signature preview computes geometry from PDF-point constants (260pt × ~96pt, centred, 10mm bottom padding) projected into rendered CSS pixels for byte-equivalent overlay-to-stamp alignment. `/api/sign/:token/document` payload now exposes `signaturePlacementMode` so the wizard chooses the correct final-step UI. Pre-Start review iframe intentionally untouched.
- 2026-05-08: **v2 tenant allowlist parser hardened** — `parseV2TenantConfig` in `WebhookSignature.ts` format-detects CSV vs JSON-map, surfaces parse errors at boot via `validateV2TenantConfig()`, and caches the parsed result. Default flipped to opt-out (every tenant gets v2 unless listed in `ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS`). Closes the silent-v2-disable failure mode where Architrak's `{"architrak":"<key>"}` value was treated as a one-element CSV literal.
- 2026-05-08: **Legacy webhook dispatch retired** — all three remaining `dispatchWebhook` call sites in `routes.ts` now route through `EventDispatcher.emitEvent`, so every outbound webhook is logged in the `webhook_deliveries` ledger and gets v2 dual-emit when its tenant is allowlisted. Identity capture closed: `otpIssuedAt`/`otpVerifiedAt`/`signerIpAddress`/`signerUserAgent` populated; `envelope.signed` payload now carries the §3.3 8-field `identityVerification` block plus a freshly minted `signedPdfFetchUrl`.
- 2026-04-25: **AS1–AS5 v1.0 wire contract** — schema foundation, API key middleware + per-(tenant, family) rate limiter, v1+v2 HMAC signing, idempotent EventDispatcher with `webhook_deliveries` ledger, full v1 endpoint set on `routes/v1Envelopes.ts`, and hourly `expirySweep` + daily `integrityCheck` background schedulers. Frozen contract spec at `docs/INTER_APP_CONTRACT_v1.0.md`.
- 2026-03-05: **Visual-replica signature** — admin drag-and-drop field placement editor for positioning signature/initial/date fields per page; script-font (Dancing Script) auto-generated signatures; `PdfService` embeds cursive signature + DIGITAL ENVELOPE metadata block on stamped PDFs.

## User Preferences
- Communication: terse; no emojis; no tool-name mentions.
- Don't trim `replit.md` without explicit approval.
