# Archisign — E-Signature Platform

Internal tool for a French architecture firm (Maître d'Œuvre) handling external sign-offs (clients, contractors, partners) on architectural plans and contracts. Tokenised + OTP signing, Gmail integration, full audit trail, ArchiDoc / Architrak v1.x wire contract for inter-app integration.

Companion specs (authoritative — do not restate here):
- `ARCHISIGN_ARCHITECTURE.md` — engineering standards, service boundaries, AI-agent directives
- `ARCHITECTURE.md` — system architecture, schema, API
- `docs/INTER_APP_CONTRACT_v1.0.md` — frozen Inter-App Wire Contract (v1.0 + revs); contract is law for `/api/v1/*`

## Stack
- **Runtime**: Node 20, PostgreSQL 16 (Replit-hosted)
- **Frontend**: React 18 + Vite 7 + Tailwind 3 + Shadcn (Radix) + wouter + TanStack Query 5 + react-hook-form + zod
- **Backend**: Express 5 + TypeScript (tsx in dev, esbuild bundle to `dist/index.cjs` in prod)
- **DB**: Drizzle ORM 0.39 over `pg` (no Neon HTTP driver — direct Postgres)
- **PDF**: `pdf-lib` + `@pdf-lib/fontkit` (server stamp); `pdfjs-dist` 5 (client canvas render)
- **File Storage**: Replit Object Storage (GCS-backed) via `@google-cloud/storage`; client uploads via Uppy
- **Email**: Gmail API (`googleapis`, lazy-loaded) through Replit Google Mail connector
- **Auth**: Google Workspace OAuth 2.0 (`openid-client` + `passport`, lazy OIDC discovery) for admin; token + OTP for external signers
- **Tests**: Node test runner suites under `server/**/__tests__/*.test.ts` (~170 tests) + Playwright (`tests/e2e`)

## Commands
| Command            | Purpose                                                |
|--------------------|--------------------------------------------------------|
| `npm run dev`      | Dev server (Express + Vite middleware) on port 5000    |
| `npm run build`    | Bundle via `tsx script/build.ts` → `dist/`             |
| `npm run start`    | Prod server: `node dist/index.cjs`                     |
| `npm run check`    | `tsc` typecheck                                        |
| `npm run db:push`  | `drizzle-kit push` — push schema to DB (no migrations) |
| `./scripts/run-node-tests.sh` | Run every Node-level suite; also invoked by `scripts/post-merge.sh` so pre-deploy fails if any suite fails |

Workflow `Start application` runs `npm run dev`. Deployment target is **Reserved VM** (port 5000 → 80); prod boot is optimized (~0.5s to first response — port binds first, `GET /health` is instant/no-DB, heavy deps lazy).

## Non-obvious layout pointers
- `server/routes.ts` — admin + signer-token routes; keep under ~1,000 lines (split new route families into `server/routes/*.ts` with injectable `build*Handler` factories, e.g. `resend.ts`, `continuation.ts`)
- `server/routes/v1*.ts` — wire-contract endpoints (apiKeyAuth + rateLimit on router)
- `server/services/PdfService.ts` — pdf-lib stamping; **authoritative coordinate system**
- `server/utils/ssrfGuard.ts` — `safeFetch`/`assertSafeUrl` for ALL outbound URL fetches (pinned DNS, redirects disabled)
- `server/replit_integrations/` — generated wrappers (auth, object_storage); don't hand-edit
- `shared/schema.ts` — Drizzle tables + Zod schemas (single source of truth for DB shape)
- `scripts/post-merge.sh` — post-merge reconciliation hook

## Database
- Driver: `pg` + Drizzle. Schema push via `npm run db:push` — **no migration files; never create a `migrations/` folder**
- Envelopes soft-delete via `deleted_at`; audit rows may have `envelopeId = null` (system events)
- Signed envelopes are immutable — further signatures go via continuation envelopes (new linked draft, cert pages stripped, non-null parent hash)

## Inter-App Wire Contract
Authoritative spec: `docs/INTER_APP_CONTRACT_v1.0.md` (includes v1.3 contacts channel, v1.4 email-rendering rev). Do not change `/api/v1/*` request/response shapes without a contract rev.
- API keys: `apiKeyAuth` resolves `X-API-KEY` against CSV in `ARCHIDOC_API_KEY` / `ARCHITRAK_API_KEY` → `req.apiKeyAuth = {tenant, keyHash}`
- Rate limits are per-(tenant, family) token buckets; contacts endpoints are archidoc-tenant-only
- All outbound webhooks go through `EventDispatcher.emitEvent` (idempotent ledger, v1+v2 dual-emit gated by `ARCHISIGN_WEBHOOK_V2_TENANTS`)
- Schedulers (`server/jobs/scheduler.ts`): hourly `expirySweep`, daily `integrityCheck`; disable with `ARCHISIGN_DISABLE_SCHEDULERS=1` in tests/CI

## Authentication & Authorization
- **Admin**: Google Workspace OAuth 2.0 via `server/services/GoogleAuthService.ts`; OIDC discovery is lazy (first `/api/login`), memoized 1h
- The `hd` claim is re-checked server-side from the signed ID token — never trust the URL param; `email_verified` required
- Domain rule: session email must end in `@<ARCHISIGN_ALLOWED_EMAIL_DOMAIN>` (default `renosud.com`); `ADMIN_EMAILS` (CSV) further narrows; denial destroys session + audits
- All `/api/*` protected EXCEPT `/api/sign/:token/*`, `/api/v1/*`, and the OAuth handshake routes
- `E2E_AUTH_BYPASS=1` (dev/test only) skips the domain check
- Sessions: connect-pg-simple, 7-day TTL, `SESSION_SECRET` required

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
| ARCHISIGN_ALLOWED_EMAIL_DOMAIN          | env    | No          | Email domain admin sign-in is restricted to (default `renosud.com`)         |
| ADMIN_EMAILS                            | env    | No          | CSV allowlist of admin emails (further narrowing on top of the domain rule) |
| SESSION_SECRET                          | secret | Auto        | Express session secret                                                      |
| DEFAULT_OBJECT_STORAGE_BUCKET_ID        | secret | Auto        | Object Storage bucket ID                                                    |
| PRIVATE_OBJECT_DIR                      | secret | Auto        | Object Storage private directory path                                       |
| PUBLIC_OBJECT_SEARCH_PATHS              | secret | Auto        | Object Storage public search paths                                          |
| GOOGLE_OAUTH_CLIENT_ID                  | secret | Yes         | Google Workspace OAuth 2.0 web client ID (Renosud Google Cloud Console)     |
| GOOGLE_OAUTH_CLIENT_SECRET              | secret | Yes         | Google Workspace OAuth 2.0 web client secret; pairs with the client ID above |
| REPLIT_CONNECTORS_HOSTNAME, REPL_IDENTITY, WEB_REPL_RENEWAL | env | Auto | Replit connector plumbing (Gmail, Object Storage) |

## AI-Agent Gotchas
- **Don't edit `package.json`** — use the package manager tool instead.
- **Don't touch `vite.config.ts`, `server/vite.ts`, or `drizzle.config.ts`** unless absolutely necessary; they are wired for the Replit single-port setup.
- **Schema changes ship via `npm run db:push`** — no migration files; do not invent a `migrations/` folder.
- **`PdfService.stampSignedPdf` is the authoritative coordinate system.** Any client-side preview (e.g. `LockedPageView`) must project from the same PDF-point geometry — never re-derive from CSS pixels.
- **All outbound webhooks must go through `EventDispatcher.emitEvent`** — never call HTTP directly; the ledger and v2 dual-emit depend on it.
- **All outbound URL fetches (user-supplied URLs) must go through `server/utils/ssrfGuard.ts`** — never raw `fetch`.
- **`/api/v1/*` is API-key auth only** — never wrap it in the admin OAuth middleware.
- **No PDF/crypto/email logic in route handlers** — services only; routes use `asyncHandler` + `validateId`; DB via `IStorage` (direct `db` only for transactions).
- **Object Storage filename inputs**: validate `..` / `/` rejection on any new endpoint that accepts a filename; layout `<prefix>/uploads/` + `<prefix>/backups/`.
- **Keep boot fast**: port binds before route setup; no awaited network calls (OIDC discovery, googleapis) on the boot path; `GET /health` must stay instant and DB-free.
- Length-guarded `timingSafeEqual` on every HMAC/OTP compare; tokens/OTPs/API keys redacted in logs.
- This is **Archisign**. The companion projects are **ArchiDoc** (document ingest) and **Architrak** (project tracker). Requests about meeting agendas, attendees, plan changes, image-paste editors, etc. belong to those — not here.

## User Preferences
- Communication: terse; no emojis; no tool-name mentions.
- **Do not modify or trim `replit.md` without explicit user approval in the current turn.** If asked to clean it up, propose changes for review first, await confirmation, then apply.
