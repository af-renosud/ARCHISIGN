# Archisign — E-Signature Platform

Internal tool for a French architecture firm (Maître d'Œuvre) handling external sign-offs (clients, contractors, partners) on architectural plans and contracts. Tokenised + OTP signing, Gmail integration, full audit trail, ArchiDoc / Architrak v1.0 wire contract for inter-app integration.

Companion specs:
- `ARCHISIGN_ARCHITECTURE.md` — engineering standards, service boundaries, AI-agent directives
- `ARCHITECTURE.md` — system architecture, schema, API
- `docs/INTER_APP_CONTRACT_v1.0.md` — frozen Inter-App Wire Contract

## Stack
- **Runtime**: Node 20, PostgreSQL 16 (Replit-hosted)
- **Frontend**: React 18 + Vite 7 + Tailwind 3 + Shadcn (Radix) + wouter + TanStack Query 5 + react-hook-form + zod
- **Backend**: Express 5 + TypeScript (tsx in dev, esbuild bundle to `dist/index.cjs` in prod)
- **DB**: Drizzle ORM 0.39 over `pg` (no Neon HTTP driver — direct Postgres)
- **PDF**: `pdf-lib` + `@pdf-lib/fontkit` (server stamp); `pdfjs-dist` 5 (client canvas render)
- **File Storage**: Replit Object Storage (GCS-backed) via `@google-cloud/storage`; client uploads via Uppy
- **Email**: Gmail API (`googleapis`) through Replit Google Mail connector
- **Auth**: Replit Auth OIDC (`openid-client` + `passport`) for admin; token + OTP for external signers
- **Tests**: Playwright (`tests/e2e`) + a Node test suite for `WebhookSignature`

## Commands
| Command            | Purpose                                                |
|--------------------|--------------------------------------------------------|
| `npm run dev`      | Dev server (Express + Vite middleware) on port 5000    |
| `npm run build`    | Bundle via `tsx script/build.ts` → `dist/`             |
| `npm run start`    | Prod server: `node dist/index.cjs`                     |
| `npm run check`    | `tsc` typecheck                                        |
| `npm run db:push`  | `drizzle-kit push` — push schema to DB (no migrations) |

Workflow `Start application` runs `npm run dev`. Deployment target is `autoscale` (port 5000 → 80).

## Project Structure
```
client/src/
  pages/
    dashboard.tsx              Admin envelope table (10s auto-refresh)
    envelope-new.tsx           Create envelope (PDF upload + signers)
    envelope-detail.tsx        Tabs: overview / signers / communication / audit
    envelope-field-editor.tsx  Drag-and-drop field placement (signature/initial/date) with undo/redo
    signer-verify.tsx          External OTP verification
    signer-document.tsx        Pre-Start review iframe + locked single-page wizard
    settings.tsx               Email copy, firm name
    rollback-ledger.tsx        Version ledger
    data-recovery.tsx          Soft-deleted envelopes + backup management
    pre-deployment.tsx         Pre-deployment audit prompts
    login.tsx                  Split-screen Replit Auth
    not-found.tsx
  components/
    locked-page-view.tsx       pdfjs-dist canvas with on-page placeholders
    ObjectUploader.tsx         Uppy dashboard wrapper for Object Storage uploads
    app-sidebar.tsx, theme-toggle.tsx, ui/

server/
  index.ts                     Express bootstrap (25 MB JSON, graceful shutdown, scheduler boot, v2 allowlist validation)
  routes.ts                    Admin + signer-token routes
  routes/v1Envelopes.ts        v1.0 wire contract endpoints (apiKeyAuth + rateLimit on router)
  storage.ts                   IStorage data-access layer
  fileStorage.ts               Object Storage abstraction (PDFs + backups)
  db.ts                        Drizzle / Postgres connection
  gmail.ts                     Gmail API integration
  seed.ts                      Email-settings seeder
  static.ts, vite.ts           Prod static / dev Vite middleware
  fonts/                       Embedded fonts (Dancing Script, etc.)
  jobs/scheduler.ts            Hourly expirySweep + daily integrityCheck
  middleware/
    apiKeyAuth.ts              X-API-KEY → tenant resolution
    rateLimit.ts               Per-(tenant, family) token bucket
    asyncHandler.ts, validators.ts
  services/
    PdfService.ts              pdf-lib stamping (authoritative coordinate system)
    SecurityService.ts         Tokens / OTP / signing-link crypto
    NotificationService.ts     Email templates + completion notifications
    WebhookSignature.ts        v1/v2 HMAC sign + verify; v2 tenant-allowlist parser
    EventDispatcher.ts         7-event idempotent dispatch via webhook_deliveries
    __tests__/WebhookSignature.test.ts
  replit_integrations/         Generated wrappers (auth, object_storage)

shared/
  schema.ts                    Drizzle tables, enums, Zod schemas, relations
  models/auth.ts               users + sessions (Replit Auth)

scripts/
  post-merge.sh                Post-merge reconciliation hook
  reconcile-envelope-22.ts     One-off data fix (kept for reference)

tests/e2e/                     Playwright specs (config: playwright.config.ts)
docs/INTER_APP_CONTRACT_v1.0.md
```

## Database
Driver: `pg` + Drizzle. Schema push via `npm run db:push` (no migration files).

**Enums**: `envelope_status` (incl. terminal `expired`, `void`), `annotation_type`, `webhook_delivery_state` (pending / succeeded / dead_lettered), `signature_placement_mode`, `rollback_version_status`.

**Tables**:
- `envelopes` — soft-delete via `deleted_at`; v1.0 columns: `expires_at`, `decline_reason`, `origin`, `retention_breach_at`, `retention_incident_ref`, `retention_detected_at`
- `signers` — token + OTP auth; v1.0 identity columns: `otp_issued_at`, `otp_verified_at`, `signer_ip_address`, `signer_user_agent`, `access_token_rotated_at`, `previous_access_token_hash`
- `annotations` — initials/signatures per page (signerId FK, x/y, w/h, type, value, placed)
- `communication_logs` — query messages between parties
- `audit_events` — full audit trail (envelopeId nullable for system events)
- `webhook_deliveries` — outbound dispatch ledger (UUID `event_id` idempotency key, attempts counter, raw payload + signature audit)
- `settings` — k/v config (email copy, firm name, …)
- `rollback_versions`, `backups`
- `users`, `sessions` — Replit Auth + connect-pg-simple

## Inter-App Wire Contract v1.0 (frozen 2026-04-25)
Authoritative spec: `docs/INTER_APP_CONTRACT_v1.0.md`. AS1 → AS5 fully landed:
- Schema foundation (enums, columns, ledger, IStorage methods)
- API-key middleware (ARCHIDOC + ARCHITRAK), per-(key, family) rate limit (60 RPM / 30 burst / 5000 day), v1 + v2 HMAC signing
- `EventDispatcher` with idempotent ledger; 7 canonical events; v1+v2 dual-emit gated by `ARCHISIGN_WEBHOOK_V2_TENANTS` (default-on, opt-out via `ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS`)
- v1 endpoints: `pdfFetchUrl` ingest, `/send` Idempotency-Key, `/signed-pdf-url` re-mint with §3.8 410 retention_breach, `/signed-pdf-fetch` HMAC URL (15-min TTL)
- Schedulers: hourly `expirySweep` (atomic → `expired` + `envelope.expired`); daily `integrityCheck` (signed-PDF probe → `retention_breach_at` + `envelope.retention_breach`)

### v1.0 endpoints
- `POST /api/v1/envelopes/create` — accepts `pdfBase64`, `pdfUrl`, or `pdfFetchUrl` (60 s budget, 25 MiB cap); `signers[]`, optional `expiresAt`, `metadata`, `fields[]`, `identityVerification.method`; returns §3.5.1 shape with `signers[].accessUrl` + `otpDestination`
- `POST /api/v1/envelopes/:id/send` — idempotent on `{sent, viewed, queried}` (200); rejects `{signed, declined, expired, void}` with 409
- `GET /api/v1/envelopes/:id/signed-pdf-url` — mints 15-min HMAC URL; 410 + §3.8 `retention_breach` body when breached
- `GET /api/v1/envelopes/:envelopeId/signed-pdf-fetch?exp=&sig=` — streams PDF when HMAC matches
- Rate-limit body matches §3.6.1 (`error`, `retryAfter`, `limit`, `currentUsage`, `ceiling`); `X-RateLimit-Remaining` set on 200s

## Authentication & Authorization
- **Admin**: Replit Auth OIDC (Google / GitHub / Apple / email-pwd); all `/api/*` protected EXCEPT `/api/sign/:token/*` and `/api/v1/*`
- **Optional allowlist**: `ADMIN_EMAILS` (CSV)
- **Sessions**: connect-pg-simple, 7-day TTL, `SESSION_SECRET` required
- **API keys**: `apiKeyAuth` resolves `X-API-KEY` against CSV in `ARCHIDOC_API_KEY` / `ARCHITRAK_API_KEY`; attaches `req.apiKeyAuth = {tenant, keyHash}`
- **Audit**: unauthorised attempts logged to `audit_events`

## Object Storage
- All PDFs and backups live in Replit Object Storage (GCS), persistent across deploys
- `fileStorage.ts`: `uploadFile`, `downloadFile`, `streamFileToResponse`, `fileExists`, `deleteFile`, `uploadBackup`, `downloadBackup`, `deleteBackupFile`
- Upload flow: Multer temp file → buffer → upload → temp delete in `finally`
- Serving: `/uploads/:filename` streams directly (no full-buffering)
- Filename validation rejects `..` / `/` segments
- Layout: `<bucket>/<prefix>/uploads/` for PDFs, `<bucket>/<prefix>/backups/` for backups
- Orphan cleanup: failed DB transaction after PDF save deletes the saved file

## Security & Integrity
- Path-traversal hardening on all filename inputs
- OTP stored as SHA-256 hash; verification timing-safe
- ACID transactions for envelope/signer creation; atomic double-sign prevention via conditional UPDATE
- Zod validation on all inbound payloads (admin + v1)
- HMAC SHA-256 webhook signing: v1 `x-archisign-signature`; v2 `${ts}.${rawBody}` per §3.9, dual-emitted to allowlisted tenants
- Length-guarded `timingSafeEqual` on every HMAC verify
- Webhook delivery: 5 attempts, exponential backoff `[1s, 3s, 10s, 30s]`, 10 s per-attempt timeout; non-retryable 4xx (except 429) → `dead_lettered`
- Graceful shutdown drains in-flight requests
- Email-failure-safe send flow (DB state + audit recorded before email dispatch)
- Log sanitisation: tokens, OTPs, API keys redacted

## Guided Signing Flow
- **Pre-Start**: native browser PDF viewer for free-form review
- **After Start**: per-page wizard locks each page to a single anchored `pdfjs-dist` canvas — no toolbar, sidebar, zoom, or scroll
- Admin-placed initial/signature fields render as orange-dashed placeholders → placed markers (Dancing Script for signatures, glyph text for initials) at the same coordinates `PdfService.stampSignedPdf` uses
- Fixed-bottom signature mode projects exact PDF-point geometry (260 pt × ~96 pt, centred, 10 mm bottom padding) into rendered CSS pixels so on-screen preview matches the stamped output
- `/api/sign/:token/document` payload exposes `signaturePlacementMode` so the wizard chooses the right final-step UI

## Environment Variables & Secrets
| Variable                                | Type   | Required    | Description                                                                 |
|-----------------------------------------|--------|-------------|-----------------------------------------------------------------------------|
| DATABASE_URL                            | env    | Yes         | PostgreSQL connection string (auto-provided)                                |
| ARCHIDOC_API_KEY                        | secret | Yes         | CSV of API keys for ArchiDoc tenant                                         |
| ARCHITRAK_API_KEY                       | secret | No          | CSV of API keys for Architrak tenant                                        |
| ARCHISIGN_WEBHOOK_SECRET                | secret | No          | HMAC secret for v1+v2 webhook payload signing                               |
| ARCHISIGN_WEBHOOK_V2_TENANTS            | env    | No (legacy) | CSV or JSON-map allowlist override; when set, ONLY listed tenants get v2    |
| ARCHISIGN_WEBHOOK_V2_DISABLED_TENANTS   | env    | No          | CSV opt-out list (consulted only when the legacy allowlist is unset)        |
| ARCHISIGN_SIGNED_URL_SECRET             | secret | No          | HMAC secret for /signed-pdf-fetch URLs; falls back to `ARCHISIGN_WEBHOOK_SECRET` |
| ARCHISIGN_RETENTION_REMEDIATION_CONTACT | env    | No          | Email returned in 410 retention_breach + retention_breach event body        |
| ARCHISIGN_DISABLE_SCHEDULERS            | env    | No          | Set to `1` to disable expirySweep + integrityCheck (test/CI)                |
| ADMIN_EMAILS                            | env    | No          | CSV allowlist of admin emails                                               |
| SESSION_SECRET                          | secret | Auto        | Express session secret                                                      |
| DEFAULT_OBJECT_STORAGE_BUCKET_ID        | secret | Auto        | Object Storage bucket ID                                                    |
| PRIVATE_OBJECT_DIR                      | secret | Auto        | Object Storage private directory path                                       |
| PUBLIC_OBJECT_SEARCH_PATHS              | secret | Auto        | Object Storage public search paths                                          |
| REPLIT_CONNECTORS_HOSTNAME, REPL_IDENTITY, ISSUER_URL, REPL_ID, WEB_REPL_RENEWAL | env | Auto | Replit OIDC + connector plumbing |

## AI-Agent Gotchas
- **Don't edit `package.json`** — use the package manager tool instead.
- **Don't touch `vite.config.ts`, `server/vite.ts`, or `drizzle.config.ts`** unless absolutely necessary; they are wired for the Replit single-port setup.
- **Schema changes ship via `npm run db:push`** — there are no migration files; do not invent a `migrations/` folder.
- **`PdfService.stampSignedPdf` is the authoritative coordinate system.** Any client-side preview (e.g. `LockedPageView`) must project from the same PDF-point geometry — never re-derive from CSS pixels.
- **All outbound webhooks must go through `EventDispatcher.emitEvent`** — never call HTTP directly; the ledger and v2 dual-emit depend on it.
- **`/api/v1/*` is API-key auth only** — never wrap it in the admin OIDC middleware.
- **Object Storage filename inputs**: validate `..` / `/` rejection on any new endpoint that accepts a filename.
- This is **Archisign**. The companion projects are **ArchiDoc** (document ingest) and **Architrak** (project tracker). Requests about meeting agendas, attendees, plan changes, image-paste editors, etc. belong to those — not here.

## User Preferences
- Communication: terse; no emojis; no tool-name mentions.
- **Do not modify or trim `replit.md` without explicit user approval in the current turn.** If asked to clean it up, propose changes for review first, await confirmation, then apply.
