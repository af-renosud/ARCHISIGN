# Archisign - E-Signature Platform

## Overview
Archisign is a specialized internal tool for a French architecture firm (Ma&icirc;tre d'&OElig;uvre) to handle external sign-offs (clients, contractors, partners) for architectural plans and contracts. It integrates with Gmail for email communication and provides a secure, tokenized signing workflow with OTP verification and full audit trails.

See `ARCHITECTURE.md` for detailed system architecture, database schema, and API documentation.

## Architecture
- **Frontend**: React + Vite + Tailwind CSS + Shadcn UI
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL (Replit-hosted, Drizzle ORM)
- **Email**: Gmail API via Replit Google Mail connector
- **PDF**: pdf-lib for document processing
- **File Storage**: Replit Object Storage (GCS-backed, persistent across deploys)
- **Auth**: Replit Auth (OIDC) for admin, Token+OTP for external signers

## Key Features
1. **Admin Dashboard** - Table view of all envelopes with filtering by status, client, reference (10s auto-refresh)
2. **Envelope Management** - Create, send, track document sign-off workflows
3. **External Signer Interface** - Tokenized URL, OTP verification, page-by-page initials, final signature
4. **Query Loop** - Signers can request clarification, triggering Gmail threads
5. **ArchiDoc API** - POST /api/v1/envelopes/create for service-to-service integration
6. **Webhook Callbacks** - Notify ArchiDoc on status changes
7. **Settings Page** - Admin-editable email copy text stored in DB

## Database Schema
- `envelopes` - Documents sent for signing (soft-delete via `deleted_at` column)
- `signers` - External parties who sign (token + OTP auth)
- `annotations` - Initials/signatures per page (signerId FK, xPos, yPos, type, value)
- `communication_logs` - Query messages between parties
- `audit_events` - Full audit trail (nullable envelopeId for system events)
- `settings` - Key-value configuration (email copy text, firm name, etc.)
- `rollback_versions` - Version tracking ledger (label, note, status: active/superseded)
- `backups` - Backup file metadata (filename, created_at)
- `users` - Authenticated admin users (Replit Auth, OIDC)
- `sessions` - Server-side session storage for auth (connect-pg-simple)

## Project Structure
```
client/src/
  pages/dashboard.tsx        - Admin dashboard (30s auto-refresh)
  pages/envelope-new.tsx     - Create envelope form (PDF upload + signers)
  pages/envelope-detail.tsx  - Envelope detail + tabs (overview, signers, communication, audit)
  pages/signer-verify.tsx    - External OTP verification
  pages/signer-document.tsx  - Document signing interface (page-by-page initials + signature)
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

### Phase 4 (Completed)
- **Object Storage Migration**: All PDFs and backups stored in Replit Object Storage (GCS-backed)
- **Persistent Files**: Files survive deployments and container restarts
- **fileStorage.ts**: Abstraction layer for upload/download/stream/delete with automatic bucket/prefix parsing
- **Multer temp cleanup**: Uploaded files streamed to Object Storage, temp files cleaned up in `finally` blocks
- **Streaming serving**: `/uploads` route streams from Object Storage — memory-efficient for large PDFs

### Phase 1 (Completed)
- Path traversal protection on /uploads route (filename validation, no path traversal)
- OTP generation via crypto.randomInt() + SHA-256 hashing before DB storage
- All synchronous file I/O converted to async fs/promises
- Log sanitization: accessToken, otpCode, otpExpiresAt redacted from response logs

### Phase 2 (Completed)
- **ACID Transactions**: Envelope creation and signing flow wrapped in db.transaction()
- **N+1 Query Fix**: Batch signer fetch with inArray() instead of per-envelope queries
- **Double-Sign Prevention**: atomicClaimSign() with conditional UPDATE (WHERE signedAt IS NULL)
- **Clean Transaction Boundaries**: PDF file generation after transaction commit

### Phase 3 (Completed)
- **Schema Validation**: All routes use Zod schemas for input validation
- **Graceful Shutdown**: SIGTERM/SIGINT handling with 10-second forced-exit timeout
- **Error Handling**: Email failures prevent envelope status change; webhook errors isolated

## Environment Variables & Secrets
| Variable                         | Type   | Required | Description                                      |
|----------------------------------|--------|----------|--------------------------------------------------|
| DATABASE_URL                     | env    | Yes      | PostgreSQL connection string (auto-provided)     |
| ARCHIDOC_API_KEY                 | secret | Yes      | API key for ArchiDoc service-to-service auth     |
| ARCHISIGN_WEBHOOK_SECRET         | secret | No       | HMAC SHA-256 secret for webhook payload signing  |
| ADMIN_EMAILS                     | env    | No       | Comma-separated allowlist of admin emails        |
| DEFAULT_OBJECT_STORAGE_BUCKET_ID | secret | Auto     | Object Storage bucket ID (auto-configured)       |
| PRIVATE_OBJECT_DIR               | secret | Auto     | Object Storage private directory path            |
| PUBLIC_OBJECT_SEARCH_PATHS       | secret | Auto     | Object Storage public search paths               |
| SESSION_SECRET                   | secret | Auto     | Express session secret (auto-configured)         |

## Recent Changes
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
