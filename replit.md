# Archisign - E-Signature Platform

## Overview
Archisign is a specialized internal tool for a French architecture firm to handle external sign-offs (clients, contractors, partners) for architectural plans and contracts. It integrates with Gmail for email communication and provides a secure, tokenized signing workflow.

## Architecture
- **Frontend**: React + Vite + Tailwind CSS + Shadcn UI
- **Backend**: Express.js
- **Database**: PostgreSQL (Replit-hosted, Drizzle ORM)
- **Email**: Gmail API via Replit Google Mail connector
- **PDF**: pdf-lib for document processing

## Key Features
1. **Admin Dashboard** - Table view of all envelopes with filtering by status, client, reference
2. **Envelope Management** - Create, send, track document sign-off workflows
3. **External Signer Interface** - Tokenized URL, OTP verification, page-by-page initials, final signature
4. **Query Loop** - Signers can request clarification, triggering Gmail threads
5. **ArchiDoc API** - POST /api/v1/envelopes/create for service-to-service integration
6. **Webhook Callbacks** - Notify ArchiDoc on status changes

## Database Schema
- `envelopes` - Documents sent for signing (soft-delete via `deleted_at` column)
- `signers` - External parties who sign
- `annotations` - Initials/signatures per page
- `communication_logs` - Query messages between parties
- `audit_events` - Full audit trail
- `settings` - Key-value configuration (email copy text, firm name, etc.)
- `rollback_versions` - Version tracking ledger (label, note, status: active/superseded)
- `backups` - Backup file metadata (filename, created_at)
- `users` - Authenticated admin users (Replit Auth, OIDC)
- `sessions` - Server-side session storage for auth (connect-pg-simple)

## Project Structure
```
client/src/
  pages/dashboard.tsx        - Admin dashboard
  pages/envelope-new.tsx     - Create envelope form
  pages/envelope-detail.tsx  - Envelope detail + tabs (overview, signers, communication, audit)
  pages/signer-verify.tsx    - External OTP verification
  pages/signer-document.tsx  - Document signing interface
  pages/settings.tsx         - Admin settings (email copy text)
  pages/rollback-ledger.tsx  - Rollback version ledger
  pages/data-recovery.tsx    - Deleted envelopes + backup management
  pages/pre-deployment.tsx   - Pre-deployment audit prompts
  pages/login.tsx            - Login page (split-screen, Replit Auth)
  components/app-sidebar.tsx - Navigation sidebar (user info + logout)
  components/theme-toggle.tsx - Dark/light mode
  hooks/use-auth.ts          - Auth state hook (useAuth)
  lib/auth-utils.ts          - Auth error utilities
  lib/theme-provider.tsx     - Theme context

server/
  routes.ts    - All API endpoints (admin routes protected by auth middleware)
  storage.ts   - Database storage layer
  db.ts        - Drizzle/PostgreSQL connection
  gmail.ts     - Gmail API integration
  seed.ts      - Sample data seeder
  replit_integrations/auth/  - Replit Auth OIDC module (passport, sessions, user storage)

shared/
  schema.ts    - Drizzle models + Zod schemas
  models/auth.ts - Users + sessions tables (Replit Auth)
```

## Key Features (continued)
7. **Settings Page** - Admin-editable email copy text (firm name, registration line, footer, invitation/OTP/completion email bodies) stored in DB and used by all outbound email templates

## Security & Integrity Hardening

### Phase 1 (Completed)
- Path traversal protection on /uploads route (path.resolve + prefix check)
- OTP generation via crypto.randomInt() + SHA-256 hashing before DB storage
- All synchronous file I/O converted to async fs/promises
- Log sanitization: accessToken, otpCode, otpExpiresAt redacted from response logs

### Phase 2 (Completed)
- **ACID Transactions**: Envelope creation (envelope + signers + audit) and signing flow (annotation + claim + status + audit) wrapped in db.transaction()
- **N+1 Query Fix**: getEnvelopes() uses batch signer fetch with inArray() instead of per-envelope queries; getEnvelope() uses Promise.all() for parallel fetches
- **Double-Sign Prevention**: atomicClaimSign() uses conditional UPDATE (WHERE signedAt IS NULL) to prevent race conditions
- **Clean Transaction Boundaries**: PDF file generation happens after transaction commit to avoid orphan files on rollback
- Storage methods accept optional DbExecutor parameter for transaction participation

### Phase 3 – Robustness & Industrialization (Completed)
- **Schema Validation**: All input-accepting routes use Zod schemas (createEnvelopeRequestSchema, createSignerRequestSchema, createApiEnvelopeRequestSchema) instead of manual if-checks. Invalid requests are rejected immediately with field-level error details.
- **Graceful Shutdown**: server/index.ts listens for SIGTERM and SIGINT, closes HTTP server and DB pool cleanly, with a 10-second forced-exit timeout.
- **Error Handling**: Email send failures in the send flow now prevent the envelope from being marked as 'sent'. If all emails fail, the envelope stays in 'draft' and returns 502. Webhook calls are properly awaited with try/catch and a 10-second timeout. All external call errors are logged with context.

## Authentication & Authorization
- **Replit Auth (OIDC)**: Admin area protected by Replit's OpenID Connect authentication (Google, GitHub, Apple, email/password)
- **Admin Middleware**: All `/api/*` routes require authentication EXCEPT `/api/sign/:token/*` (external signer flow) and `/api/v1/*` (ArchiDoc API)
- **User Allowlist**: Optional `ADMIN_EMAILS` environment variable (comma-separated). When set, only listed emails can access admin. When empty, all authenticated users are allowed.
- **Login Page**: Split-screen design at root path for unauthenticated users
- **Session Storage**: PostgreSQL-backed sessions (connect-pg-simple), 7-day TTL
- **Unauthorized Logging**: Failed admin access attempts logged to server console with email and path

## ArchiDoc API Integration (`POST /api/v1/envelopes/create`)
- **Authentication**: `X-API-KEY` header validated against `ARCHIDOC_API_KEY` secret
- **pdfBase64**: Base64-encoded PDF content; decoded, saved to `uploads/`, page count extracted via pdf-lib
- **Multi-signer**: `signers` array `[{email, fullName}]` creates multiple signer records with access tokens
- **Backward compat**: Legacy `signerEmail`/`signerName` fields still work for single-signer requests
- **Priority**: If both `pdfBase64` and `pdfUrl` are provided, `pdfBase64` takes priority
- **Webhook**: `webhookUrl` field for status change callbacks (sent, viewed, queried, signed)

## Recent Changes
- 2026-02-13: Enhanced ArchiDoc API with pdfBase64 support, multi-signer arrays, and API key authentication
- 2026-02-13: Added Replit Auth (OIDC) for admin area protection with user allowlist, login page, and session management
- 2026-02-13: Phase 3 robustness (Zod schema validation, graceful shutdown, email-failure-safe send flow)
- 2026-02-13: Phase 2 data integrity hardening (ACID transactions, N+1 fix, atomic double-sign prevention)
- 2026-02-13: Phase 1 security hardening (path traversal, OTP hashing, async I/O, log redaction)
- 2026-02-13: Added Rollback Ledger page (version tracking with ACTIVE/SUPERSEDED statuses, CRUD operations)
- 2026-02-13: Added Data Recovery page (soft-deleted envelopes recovery, JSON backup creation/download/delete)
- 2026-02-13: Added Pre-Deployment Checks page with three audit prompt cards
- 2026-02-13: Added Settings page with editable email copy text, stored in DB settings table
- 2026-02-13: Added inline PDF viewing in envelope detail and signer document pages
- 2026-02-13: Initial MVP build with full schema, admin UI, signing flow, Gmail integration
