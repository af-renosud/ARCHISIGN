# Archisign - E-Signature Platform

## Overview
Archisign is a specialized internal tool for a French architecture firm (Ma&icirc;tre d'&OElig;uvre) to handle external sign-offs (clients, contractors, partners) for architectural plans and contracts. It integrates with Gmail for email communication and provides a secure, tokenized signing workflow with OTP verification and full audit trails.

See `ARCHISIGN_ARCHITECTURE.md` for enforced engineering standards, service boundaries, and AI agent directives.
See `ARCHITECTURE.md` for detailed system architecture, database schema, and API documentation.

## Architecture
- **Frontend**: React + Vite + Tailwind CSS + Shadcn UI
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL (Replit-hosted, Drizzle ORM)
- **Email**: Gmail API via Replit Google Mail connector
- **PDF**: pdf-lib + @pdf-lib/fontkit for document processing (custom cursive font embedding)
- **File Storage**: Replit Object Storage (GCS-backed, persistent across deploys)
- **Auth**: Replit Auth (OIDC) for admin, Token+OTP for external signers

## Key Features
1. **Admin Dashboard** - Table view of all envelopes with filtering by status, client, reference (10s auto-refresh)
2. **Envelope Management** - Create, send, track document sign-off workflows
3. **External Signer Interface** - Tokenized URL, OTP verification, page-by-page initials, final signature
4. **Query Loop** - Signers can request clarification, triggering Gmail threads
5. **ArchiDoc API** - POST /api/v1/envelopes/create for service-to-service integration
6. **Webhook Callbacks** - HMAC SHA-256 signed webhooks to ArchiDoc with exponential backoff retries
7. **Settings Page** - Admin-editable email copy text stored in DB

## Database Schema
- `envelopes` - Documents sent for signing (soft-delete via `deleted_at` column)
  - **v1.0 contract additions**: `expires_at`, `decline_reason`, `origin`, `retention_breach_at`, `retention_incident_ref`, `retention_detected_at`
  - **status enum extended** with `expired` and `void` (terminal lifecycle states per §1.2)
- `signers` - External parties who sign (token + OTP auth)
  - **v1.0 contract additions**: `otp_issued_at`, `otp_verified_at`, `signer_ip_address`, `signer_user_agent`, `access_token_rotated_at`, `previous_access_token_hash` (re-mint trail per §3.5.4)
- `annotations` - Initials/signatures per page (signerId FK, xPos, yPos, width, height, type, value, placed)
- `communication_logs` - Query messages between parties
- `audit_events` - Full audit trail (nullable envelopeId for system events)
- `webhook_deliveries` - **v1.0 outbound dispatch ledger** (eventId UUID idempotency key, state pending/succeeded/dead_lettered, attempts counter, raw payload + signature audit trail per §1.3)
- `settings` - Key-value configuration (email copy text, firm name, etc.)
- `rollback_versions` - Version tracking ledger (label, note, status: active/superseded)
- `backups` - Backup file metadata (filename, created_at)
- `users` - Authenticated admin users (Replit Auth, OIDC)
- `sessions` - Server-side session storage for auth (connect-pg-simple)

## Inter-App Wire Contract v1.0 (frozen 2026-04-25)
Authoritative spec: `docs/INTER_APP_CONTRACT_v1.0.md`. Step 4 implementation breakdown lives in Architrak's repo. Five Archisign tasks landing on dependency chain `AS1 → AS2 → {AS3, AS4} → AS5`:
- **AS1 (this commit)**: schema foundation — enum extensions, envelope/signer columns, `webhook_deliveries` table, 11 new IStorage methods
- **AS2**: API key middleware (ARCHIDOC + ARCHITRAK keys), per-(key, family) rate limit (60 RPM/30 burst/5000 day), v2 HMAC signing module
- **AS3**: 7 wire events with idempotent dispatch via `webhook_deliveries` ledger; dual-emit v1+v2 gated by `ARCHISIGN_WEBHOOK_V2_TENANTS`
- **AS4**: `pdfFetchUrl` ingestion, `/send` Idempotency-Key, `/signed-pdf-url` re-mint with §3.8 410 retention_breach response
- **AS5**: Background jobs — `expires_at` sweeper (atomic transition to `expired`), annual integrity check + `envelope.retention_breach` emission

## Project Structure
```
client/src/
  pages/dashboard.tsx        - Admin dashboard (30s auto-refresh)
  pages/envelope-new.tsx     - Create envelope form (PDF upload + signers)
  pages/envelope-detail.tsx  - Envelope detail + tabs (overview, signers, communication, audit)
  pages/envelope-field-editor.tsx - Admin drag-and-drop field placement editor (signature, initial, date fields)
  pages/signer-verify.tsx    - External OTP verification
  pages/signer-document.tsx  - Document signing interface (page-by-page initials + script-font signature)
  pages/settings.tsx         - Admin settings (email copy text, firm name)
  pages/rollback-ledger.tsx  - Rollback version ledger
  pages/data-recovery.tsx    - Deleted envelopes + backup management
  pages/pre-deployment.tsx   - Pre-deployment audit prompts
  pages/login.tsx            - Login page (split-screen, Replit Auth)
  components/app-sidebar.tsx - Navigation sidebar (logo links to dashboard, user info + logout)
  components/theme-toggle.tsx - Dark/light mode
  hooks/use-auth.ts          - Auth state hook (useAuth)
  hooks/use-toast.ts         - Toast notification hook
  lib/auth-utils.ts          - Auth error utilities
  lib/queryClient.ts         - TanStack Query client config
  lib/theme-provider.tsx     - Theme context

server/
  index.ts       - Express app setup (25MB JSON limit for large PDFs, graceful shutdown)
  routes.ts      - All API endpoints (admin routes protected by auth middleware)
  storage.ts     - Database storage layer (IStorage interface)
  fileStorage.ts - Object Storage abstraction (upload/download/stream/delete PDFs & backups)
  db.ts          - Drizzle/PostgreSQL connection
  gmail.ts       - Gmail API integration (send email, get profile)
  seed.ts        - Email settings seeder (7 default settings, no sample data)
  middleware/asyncHandler.ts            - Async route handler wrapper (forwards errors to Express error handler)
  middleware/validators.ts             - Route param validators (validateId middleware)
  services/PdfService.ts               - PDF manipulation service (getPageCount, stampSignedPdf)
  services/SecurityService.ts          - Cryptographic & auth utilities (tokens, OTP, signing links)
  services/NotificationService.ts      - Email templates, webhook dispatch, completion notifications
  replit_integrations/auth/            - Replit Auth OIDC module (passport, sessions, user storage)
  replit_integrations/object_storage/  - Object Storage client (GCS credentials, ACL)

shared/
  schema.ts      - Drizzle models + Zod schemas + relations
  models/auth.ts - Users + sessions tables (Replit Auth)
```

## Authentication & Authorization
- **Replit Auth (OIDC)**: Admin area protected by OpenID Connect (Google, GitHub, Apple, email/password)
- **Admin Middleware**: All `/api/*` routes require auth EXCEPT `/api/sign/:token/*` and `/api/v1/*`
- **User Allowlist**: Optional `ADMIN_EMAILS` env var (comma-separated). When set, only listed emails can access admin.
- **API Key Auth**: `/api/v1/*` routes validate `X-API-KEY` header against `ARCHIDOC_API_KEY` secret
- **Login Page**: Split-screen design at root path for unauthenticated users
- **Session Storage**: PostgreSQL-backed sessions (connect-pg-simple), 7-day TTL
- **Auth Audit**: Unauthorized access attempts logged to audit_events table

## ArchiDoc API Integration (`POST /api/v1/envelopes/create`)
- **Authentication**: `X-API-KEY` header validated against `ARCHIDOC_API_KEY` secret
- **pdfBase64**: Base64-encoded PDF content; decoded, saved to Object Storage, page count extracted via pdf-lib
- **Multi-signer**: `signers` array `[{email, fullName}]` creates multiple signer records with access tokens
- **Backward compat**: Legacy `signerEmail`/`signerName` fields still work for single-signer requests
- **Priority**: If both `pdfBase64` and `pdfUrl` are provided, `pdfBase64` takes priority
- **Webhook**: `webhookUrl` field for status change callbacks (sent, viewed, queried, signed)
- **Body limit**: 25MB JSON to support large architectural PDFs (~18MB original)
- **Orphan cleanup**: If DB transaction fails after PDF save, the saved file is automatically deleted from Object Storage

## File Storage (Object Storage)
- **All PDFs and backups** stored in Replit Object Storage (GCS-backed, persistent across deploys)
- **fileStorage.ts** abstraction layer: `uploadFile`, `downloadFile`, `streamFileToResponse`, `fileExists`, `deleteFile`
- **Backup functions**: `uploadBackup`, `downloadBackup`, `deleteBackupFile`
- **Upload flow**: Multer temp file → read buffer → upload to Object Storage → delete temp file (in `finally` block)
- **Serving flow**: `/uploads/:filename` route streams directly from Object Storage (no full-file buffering)
- **Path traversal protection**: Filename validated — `..` and `/` segments rejected
- **Storage layout**: `<bucket>/<prefix>/uploads/` for PDFs, `<bucket>/<prefix>/backups/` for backup exports

## Security & Integrity Hardening

### Code Refactoring (5 Phases — All Completed)
- **Phase 1 — PdfService**: All pdf-lib operations extracted to `services/PdfService.ts`
- **Phase 2 — SecurityService**: All crypto primitives extracted to `services/SecurityService.ts` (timing-safe OTP verification)
- **Phase 3 — NotificationService**: All email templates and webhook dispatch extracted to `services/NotificationService.ts`
- **Phase 4 — Middleware**: `asyncHandler` (eliminates 29 try/catch blocks) and `validateId` (eliminates 7 inline checks) extracted to `middleware/`
- **Phase 5 — Webhook Security**: HMAC SHA-256 payload signing via `x-archisign-signature` header; exponential backoff retries (3 attempts, 1s/3s delays, 10s timeout)
- **Result**: `routes.ts` reduced from 1,355 → 915 lines (32.5% reduction); all domain logic in testable services
- **Standards**: See `ARCHISIGN_ARCHITECTURE.md` for enforced engineering rules and AI agent directives

### Infrastructure Hardening (4 Phases — All Completed)
- **Phase 1**: Path traversal protection, OTP hashing (SHA-256), async I/O, log sanitization
- **Phase 2**: ACID transactions, N+1 query fix, atomic double-sign prevention
- **Phase 3**: Zod schema validation, graceful shutdown, email-failure-safe send flow
- **Phase 4**: Object Storage migration (GCS-backed), streaming file serving, Multer temp cleanup

## Environment Variables & Secrets
| Variable                         | Type   | Required | Description                                      |
|----------------------------------|--------|----------|--------------------------------------------------|
| DATABASE_URL                     | env    | Yes      | PostgreSQL connection string (auto-provided)     |
| ARCHIDOC_API_KEY                 | secret | Yes      | CSV of API keys for ArchiDoc tenant (X-API-KEY)  |
| ARCHITRAK_API_KEY                | secret | No       | CSV of API keys for Architrak tenant (X-API-KEY) |
| ARCHISIGN_WEBHOOK_SECRET         | secret | No       | HMAC secret for v1+v2 webhook payload signing    |
| ARCHISIGN_WEBHOOK_V2_TENANTS     | env    | No       | CSV of tenant keys to dual-emit v2 HMAC headers  |
| ARCHISIGN_SIGNED_URL_SECRET      | secret | No       | HMAC secret for /signed-pdf-fetch URLs (15min TTL); falls back to ARCHISIGN_WEBHOOK_SECRET |
| ARCHISIGN_RETENTION_REMEDIATION_CONTACT | env | No   | Email returned in 410 retention_breach + retention_breach event body |
| ARCHISIGN_DISABLE_SCHEDULERS     | env    | No       | Set to "1" to disable expirySweep + integrityCheck (test/CI use) |
| ADMIN_EMAILS                     | env    | No       | Comma-separated allowlist of admin emails        |
| DEFAULT_OBJECT_STORAGE_BUCKET_ID | secret | Auto     | Object Storage bucket ID (auto-configured)       |
| PRIVATE_OBJECT_DIR               | secret | Auto     | Object Storage private directory path            |
| PUBLIC_OBJECT_SEARCH_PATHS       | secret | Auto     | Object Storage public search paths               |
| SESSION_SECRET                   | secret | Auto     | Express session secret (auto-configured)         |

## Recent Changes
- 2026-05-08: **Task #19 — Legacy webhook dispatch retired**: All three remaining `dispatchWebhook` call sites in `routes.ts` (envelope.sent after admin send, envelope.queried after signer query, envelope.signed in post-sign hook) now route through `EventDispatcher.emitEvent` so every outbound webhook is logged in the `webhook_deliveries` ledger and gets v2 dual-emit when its tenant is in `ARCHISIGN_WEBHOOK_V2_TENANTS`. Identity capture closed: `otpIssuedAt` is set in `/request-otp`, `otpVerifiedAt` + `signerIpAddress` + `signerUserAgent` are set in `/verify-otp`. The `envelope.signed` payload now carries the §3.3 8-field `identityVerification` block plus a freshly minted `signedPdfFetchUrl` (15 min HMAC TTL via the now-exported `mintSignedPdfUrl`); legacy rows missing identity fields fall back to the `unavailable_pre_capture` sentinel. `dispatchWebhook` removed from `NotificationService.ts`. One-shot `scripts/reconcile-envelope-22.ts` (idempotent) flips the dead-lettered delivery #1 to `succeeded` and inserts the synthesised `envelope.signed` row for eventId `019e063b-b5a3-73a7-a363-6589ad7094ae`.
- 2026-04-25: **AS5 — Vault hygiene schedulers**: New `server/jobs/scheduler.ts` started from `server/index.ts` after `httpServer.listen`. Hourly `expirySweep` calls `markEnvelopeExpiredAtomic`, transitions any envelope past `expiresAt` to `expired`, and emits `envelope.expired` per envelope through `EventDispatcher`. Daily `integrityCheck` walks `getEnvelopesForIntegrityCheck` page-by-page, probes the signed PDF via `fileExists`, and on failure marks `retention_breach_at`/`retention_incident_ref` (`INC-YYYY-XXXXXX` format) then emits one `envelope.retention_breach` per breach. Both flows are idempotent and respect §3.7 single-receiver rule. `ARCHISIGN_DISABLE_SCHEDULERS=1` opts out for tests.
- 2026-04-25: **AS4 — v1 endpoints + middleware mount**: Extracted v1 routes to `server/routes/v1Envelopes.ts` (3 endpoints + signed-pdf-fetch handler). `POST /api/v1/envelopes/create` accepts new `pdfFetchUrl` (60s budget, 25 MiB cap), `expiresAt` (validated ≥now+1min), `metadata`, `fields`, `identityVerification.method` and returns §3.5.1 shape with `signers[].accessUrl` + `otpDestination`. `POST /api/v1/envelopes/:id/send` is idempotent on `{sent,viewed,queried}` (200) and rejects terminal states `{signed,declined,expired,void}` with 409. `GET /api/v1/envelopes/:id/signed-pdf-url` mints a 15-min HMAC-signed URL and returns 410 + §3.8 `retention_breach` body when breached. New `GET /api/v1/envelopes/:id/signed-pdf-fetch?exp=…&sig=…` streams the PDF when the HMAC matches. `apiKeyAuth` and `rateLimit` (per family `create`/`send`/`read`) are mounted on the v1 router; the inline `/api/v1/` API-key check in `routes.ts` was removed. RateLimit body now matches §3.6.1 (`error`,`retryAfter`,`limit`,`currentUsage`,`ceiling`) and sets `X-RateLimit-Remaining` on every 200.
- 2026-04-25: **AS3 — Event dispatcher with idempotent ledger**: New `server/services/EventDispatcher.ts` exports `uuidv7()`, `buildEventPayload()` pure constructor for stable byte-equal emission, and `emitEvent()` for the 7 canonical events (`envelope.sent|queried|query_resolved|declined|expired|signed|retention_breach`). Each emission persists to `webhook_deliveries` keyed by `eventId`; duplicate `eventId` returns the existing terminal state without re-dispatching. v1 HMAC is the default; v2 HMAC (`sha256(${ts}.${rawBody})` per §3.9) is dual-emitted for tenants in `ARCHISIGN_WEBHOOK_V2_TENANTS`. 5 attempts with exponential backoff `[1s,3s,10s,30s]` and 10s per-attempt timeout; non-retryable 4xx (except 429) short-circuits to `dead_lettered`. `retryDeadLettered(deliveryId)` re-runs the loop using the persisted payload for operator-triggered retries. Existing `dispatchWebhook` call sites in routes.ts left untouched (legacy v1 path) — AS4 wiring will migrate them per call site as needs arise.
- 2026-04-25: **AS2 — Webhook signing + auth + rate limiting**: New `server/services/WebhookSignature.ts` (`signV1`, `signV2`, `verifyV1`/`verifyV2` with length-guard before `timingSafeEqual`, `isV2Enabled` tenant gate, `V2_TIMESTAMP_HEADER` constant). New `server/middleware/apiKeyAuth.ts` matches presented `X-API-KEY` against CSV lists in `ARCHIDOC_API_KEY` / `ARCHITRAK_API_KEY` and attaches `req.apiKeyAuth = {tenant, keyHash}`. New `server/middleware/rateLimit.ts` per-(tenant, family) token bucket: 60 RPM sustained, 30 burst, 5000/day, families `create|send|read`, returns 429 with `Retry-After` header.
- 2026-04-25: **AS1 — Schema foundation for v1.0 wire contract**: Extended `envelope_status` enum with `expired` + `void`; added new `webhook_delivery_state` enum; new envelope columns (`expires_at`, `decline_reason`, `origin`, `retention_breach_at`, `retention_incident_ref`, `retention_detected_at`); new signer columns (`otp_issued_at`, `otp_verified_at`, `signer_ip_address`, `signer_user_agent`, `access_token_rotated_at`, `previous_access_token_hash`); new `webhook_deliveries` table for idempotent outbound dispatch ledger (eventId-keyed); 11 new IStorage methods for delivery lifecycle, atomic expiry sweep, retention-breach marking, integrity-check pagination, signer access-token rotation. Frozen contract copied to `docs/INTER_APP_CONTRACT_v1.0.md`.
- 2026-03-05: Added visual replica signature feature (DocuSign-style): admin drag-and-drop field placement editor for positioning signature/initial/date fields on document pages at envelope setup; script-font (Dancing Script) auto-generated signatures from signer's name; PdfService embeds cursive signature + DIGITAL ENVELOPE metadata on stamped PDFs; signer-document page shows admin-placed field positions with signature preview
- 2026-02-25: Completed 5-phase code refactoring: PdfService, SecurityService, NotificationService extraction; asyncHandler/validateId middleware; webhook HMAC SHA-256 signing with exponential backoff retries; routes.ts 1,355→915 lines
- 2026-02-25: Created ARCHISIGN_ARCHITECTURE.md engineering standards document with AI agent directives
- 2026-02-17: Added signed PDF delivery: download button on confirmation screen + signed PDF attached to completion email with secure download link
- 2026-02-17: Added envelope resend feature with "Resend Invitations" button for sent/viewed/queried statuses
- 2026-02-15: Reduced dashboard auto-refresh from 30s to 10s for faster status updates; made Completed stat card clickable for filtering
- 2026-02-15: Moved Sign Document button to fixed bottom bar with prominent #F97316 orange styling
- 2026-02-14: Migrated all file storage (PDFs, backups) from local filesystem to Replit Object Storage for deployment persistence
- 2026-02-14: Updated ARCHITECTURE.md and replit.md with complete Object Storage documentation
- 2026-02-13: Cleared all test data for production-ready fresh start
- 2026-02-13: Increased JSON body limit to 25MB for large architectural PDFs
- 2026-02-13: Enhanced ArchiDoc API with pdfBase64 support, multi-signer arrays, and API key authentication
- 2026-02-13: Added Replit Auth (OIDC) for admin area protection with user allowlist, login page, and session management
- 2026-02-13: Phase 3 robustness (Zod schema validation, graceful shutdown, email-failure-safe send flow)
- 2026-02-13: Phase 2 data integrity hardening (ACID transactions, N+1 fix, atomic double-sign prevention)
- 2026-02-13: Phase 1 security hardening (path traversal, OTP hashing, async I/O, log redaction)
- 2026-02-13: Added Rollback Ledger, Data Recovery, Pre-Deployment Checks, and Settings pages
- 2026-02-13: Initial MVP build with full schema, admin UI, signing flow, Gmail integration
