# Archisign — Architecture Document

## 1. System Overview

Archisign is a specialized e-signature platform built for a French architecture firm (Ma&icirc;tre d'&OElig;uvre). It handles external sign-offs from clients, contractors, and partners on architectural plans and contracts. The system provides a secure, tokenized signing workflow with OTP verification, audit trails, and Gmail integration for communications.

See `ARCHISIGN_ARCHITECTURE.md` for enforced engineering standards, service boundaries, and AI agent directives.

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ARCHISIGN                                │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   React SPA  │◄──►│  Express.js  │◄──►│   PostgreSQL     │  │
│  │  (Vite +     │    │   API Server │    │   (Drizzle ORM)  │  │
│  │  Tailwind +  │    │              │    │                  │  │
│  │  Shadcn UI)  │    │              │    │                  │  │
│  └──────────────┘    └──────┬───────┘    └──────────────────┘  │
│                             │                                   │
│              ┌──────────────┼──────────────┐                    │
│              │              │              │                    │
│       ┌──────▼──────┐ ┌────▼─────┐ ┌──────▼──────┐            │
│       │ PdfService  │ │ Security │ │Notification │            │
│       │ (pdf-lib)   │ │ Service  │ │  Service    │            │
│       └─────────────┘ │ (crypto) │ │(Gmail+HMAC) │            │
│                       └──────────┘ └──────┬──────┘            │
│                                           │                    │
│                    ┌──────────────┬────────┤                    │
│                    │              │        │                    │
│              ┌─────▼─────┐ ┌─────▼─────┐ ┌▼────────────┐      │
│              │ Gmail API │ │  Object   │ │  Webhook    │      │
│              │ (Replit   │ │  Storage  │ │  Dispatch   │      │
│              │ Connector)│ │ (GCS)     │ │ (HMAC+retry)│      │
│              └───────────┘ └───────────┘ └─────────────┘      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
         ▲                                          ▲
         │ OIDC Auth                                │ REST API + HMAC Webhooks
         │ (Admin Login)                            │
    ┌────┴─────┐                             ┌─────┴──────┐
    │  Replit   │                             │  ArchiDoc  │
    │  Auth     │                             │  (Service) │
    └──────────┘                             └────────────┘
```

## 3. Technology Stack

| Layer        | Technology                              |
|-------------|------------------------------------------|
| Frontend    | React 18 + Vite + TypeScript             |
| Styling     | Tailwind CSS + Shadcn UI                 |
| Routing     | Wouter (client-side)                     |
| State       | TanStack Query v5                        |
| Backend     | Express.js + TypeScript                  |
| ORM         | Drizzle ORM                              |
| Database    | PostgreSQL (Replit-hosted, Neon-backed)   |
| File Storage| Replit Object Storage (GCS-backed)       |
| Email       | Gmail API (Replit Google Mail connector)  |
| PDF         | pdf-lib (encapsulated in PdfService)     |
| Crypto      | Node.js crypto (encapsulated in SecurityService) |
| Auth        | Replit Auth (OpenID Connect)             |
| Sessions    | connect-pg-simple (PostgreSQL-backed)    |
| Validation  | Zod + drizzle-zod                        |

## 4. Database Schema

```
envelopes (id, subject, externalRef, message, status, originalPdfUrl,
           signedPdfUrl, totalPages, webhookUrl, gmailThreadId,
           createdAt, updatedAt, deletedAt)
    │
    ├── signers (id, envelopeId FK, email, fullName, accessToken,
    │            otpCode, otpExpiresAt, otpVerified, lastViewedAt, signedAt)
    │
    ├── annotations (id, envelopeId FK, signerId FK, pageNumber,
    │                xPos, yPos, type, value, createdAt)
    │
    ├── communication_logs (id, envelopeId FK, senderEmail,
    │                       messageBody, isExternalQuery, gmailMessageId, timestamp)
    │
    └── audit_events (id, envelopeId FK nullable, eventType, actorEmail,
                      ipAddress, metadata, timestamp)

settings (id, key UNIQUE, value, label, createdAt)
rollback_versions (id, versionLabel, note, status, createdAt)
backups (id, filename, createdAt)
users (id, email, firstName, lastName, profileImageUrl, createdAt, updatedAt)
sessions (sid PK, sess, expire)
```

### Key Design Decisions
- `envelopes.deletedAt` enables soft-delete for data recovery
- `audit_events.envelopeId` is nullable to support system-level events (auth attempts)
- `signers.otpCode` stores SHA-256 hash, never plaintext
- `signers.accessToken` is a cryptographic random hex string for tokenized URLs
- `originalPdfUrl` and `signedPdfUrl` store `/uploads/<filename>` paths; actual files live in Object Storage
- Foreign keys use CASCADE delete for referential integrity

## 5. File Storage (Object Storage)

All PDF documents and backup files are stored in Replit Object Storage (GCS-backed), ensuring persistence across deployments and container restarts.

### Architecture
```
server/fileStorage.ts (abstraction layer)
    │
    ├── uploadFile(fileName, data)       → saves to Object Storage, returns /uploads/<fileName>
    ├── downloadFile(urlPath)            → retrieves buffer from Object Storage
    ├── streamFileToResponse(urlPath, res) → streams directly to HTTP response
    ├── fileExists(urlPath)              → checks existence
    ├── deleteFile(urlPath)              → deletes from Object Storage
    ├── uploadBackup(fileName, data)     → saves backup JSON to Object Storage
    ├── downloadBackup(fileName)         → retrieves backup content
    └── deleteBackupFile(fileName)       → deletes backup file
```

### Storage Layout (within GCS bucket)
```
<bucket>/<prefix>/
    uploads/          ← PDF files (original + signed)
    backups/          ← JSON backup exports
```

### Upload Flow
1. Multer receives PDF upload to temporary local file
2. File read into memory buffer
3. Buffer uploaded to Object Storage via `uploadFile()`
4. Temp file deleted in `finally` block (cleanup guaranteed)
5. `/uploads/<filename>` path stored in database

### Serving Flow
1. `/uploads/:filename` route receives request
2. Filename validated (no `..` or `/` allowed)
3. `streamFileToResponse()` streams file directly from Object Storage to HTTP response
4. No full-file buffering — memory-efficient for large architectural PDFs

## 6. Authentication & Authorization

### Admin Area (OIDC)
- Replit Auth provides OpenID Connect authentication (Google, GitHub, Apple, email/password)
- All `/api/*` routes require authentication via middleware
- PostgreSQL-backed sessions with 7-day TTL
- Optional `ADMIN_EMAILS` environment variable restricts access to specific emails

### External Signer Flow (Token + OTP)
- `/api/sign/:token/*` routes are public (no admin auth required)
- Signers receive a unique `accessToken` URL via email
- OTP verification required before viewing/signing documents
- OTP codes are SHA-256 hashed before database storage

### ArchiDoc API (API Key)
- `/api/v1/*` routes authenticated via `X-API-KEY` header
- Validated against `ARCHIDOC_API_KEY` secret
- Separate from admin auth — service-to-service only

### Middleware Order
```
Request → OIDC Session → Admin Auth Middleware → Route Handler
                              │
                              ├─ /api/sign/:token/* → PASS (public)
                              ├─ /api/v1/*          → CHECK X-API-KEY
                              ├─ /api/login|logout  → PASS (auth flow)
                              ├─ /uploads           → PASS (file serving)
                              └─ /api/*             → REQUIRE OIDC + allowlist
```

## 7. API Routes

### Admin Routes (require OIDC auth)
| Method | Path                              | Description                    |
|--------|-----------------------------------|--------------------------------|
| GET    | /api/envelopes                    | List all envelopes             |
| GET    | /api/envelopes/deleted            | List soft-deleted envelopes    |
| GET    | /api/envelopes/:id                | Get envelope detail            |
| POST   | /api/envelopes                    | Create new envelope (multipart)|
| POST   | /api/envelopes/:id/send           | Send envelope for signing      |
| POST   | /api/envelopes/:id/resend         | Resend to pending signers      |
| POST   | /api/envelopes/:id/reply          | Reply in communication thread  |
| POST   | /api/envelopes/:id/soft-delete    | Soft-delete envelope           |
| POST   | /api/envelopes/:id/restore        | Restore soft-deleted envelope  |
| GET    | /api/settings                     | Get all settings               |
| GET    | /api/settings/:key                | Get single setting             |
| PUT    | /api/settings                     | Update settings (array)        |
| GET    | /api/rollback-versions            | List rollback versions         |
| POST   | /api/rollback-versions            | Create rollback version        |
| PATCH  | /api/rollback-versions/:id        | Update rollback version        |
| DELETE | /api/rollback-versions/:id        | Delete rollback version        |
| GET    | /api/backups                      | List backups                   |
| POST   | /api/backups                      | Create backup                  |
| GET    | /api/backups/:id/download         | Download backup file           |
| DELETE | /api/backups/:id                  | Delete backup                  |

### External Signer Routes (public, token-authenticated)
| Method | Path                              | Description                    |
|--------|-----------------------------------|--------------------------------|
| GET    | /api/sign/:token/info             | Get signer + envelope info     |
| POST   | /api/sign/:token/request-otp      | Send OTP to signer email       |
| POST   | /api/sign/:token/verify-otp       | Verify OTP code                |
| GET    | /api/sign/:token/document         | Get document info for signing  |
| POST   | /api/sign/:token/initial          | Save page initial annotation   |
| POST   | /api/sign/:token/query            | Send clarification query       |
| POST   | /api/sign/:token/sign             | Final signature submission     |
| GET    | /api/sign/:token/download         | Download signed PDF            |

### ArchiDoc API (API key authenticated)
| Method | Path                              | Description                    |
|--------|-----------------------------------|--------------------------------|
| POST   | /api/v1/envelopes/create          | Create envelope via API        |

### File Serving (public)
| Method | Path                              | Description                    |
|--------|-----------------------------------|--------------------------------|
| GET    | /uploads/:filename                | Stream PDF from Object Storage |

## 8. ArchiDoc Integration

### Inbound (ArchiDoc → Archisign)
- `POST /api/v1/envelopes/create` with `X-API-KEY` header
- Accepts `pdfBase64` (base64-encoded PDF, decoded and saved to Object Storage)
- Accepts `signers` array `[{email, fullName}]` for multi-signer envelopes
- Backward compatible with legacy `signerEmail`/`signerName` fields
- Returns full envelope object with signer details
- JSON body limit: 25MB (supports architectural documents up to ~18MB)
- Orphan cleanup: if DB transaction fails after PDF save, the Object Storage file is automatically deleted

### Outbound Webhooks (Archisign → ArchiDoc)
- Webhook callbacks to `webhookUrl` on status changes
- Events: `envelope.sent`, `envelope.viewed`, `envelope.queried`, `envelope.signed`
- Query events include `queryFrom` (signer email) and `queryMessage` (the question text)

#### HMAC SHA-256 Payload Signing
- All webhook payloads are signed using HMAC SHA-256 with `ARCHISIGN_WEBHOOK_SECRET`
- The hex signature is attached via the `x-archisign-signature` HTTP header
- The payload is stringified once — the same string is used for both signing and the request body
- If no secret is configured, webhooks are sent unsigned (backward compatible)
- Receiving side verifies by computing `HMAC-SHA256(secret, rawRequestBody)` and comparing to the header using timing-safe comparison

#### Exponential Backoff & Retries
- Up to 3 delivery attempts per webhook
- Retries on network errors and 5xx server responses only
- 4xx client errors fail immediately (no retry)
- Backoff delays: 1 second after attempt 1, 3 seconds after attempt 2
- 10-second timeout per individual attempt
- Structured logging: `[Webhook] Attempt X/3 ...` for each attempt

#### Webhook Payload Examples
```json
// envelope.sent
{"event": "envelope.sent", "envelopeId": 19, "externalRef": "ARCHIDOC-ESIGN-7", "status": "sent"}

// envelope.queried
{"event": "envelope.queried", "envelopeId": 19, "externalRef": "ARCHIDOC-ESIGN-7", "status": "queried", "queryFrom": "signer@example.com", "queryMessage": "I need clarification on section 3."}

// envelope.signed
{"event": "envelope.signed", "envelopeId": 19, "externalRef": "ARCHIDOC-ESIGN-7", "status": "signed"}
```

## 9. Service Architecture

The backend follows a layered service architecture. Route handlers in `routes.ts` act as thin traffic controllers that delegate all domain logic to dedicated services.

### Service Layer
```
server/services/
├── PdfService.ts           — PDF manipulation (pdf-lib encapsulated)
│   ├── getPageCount(pdfBytes)           → number of pages
│   └── stampSignedPdf(pdfBytes, ...)    → stamped PDF with initials, signatures, footer
│
├── SecurityService.ts      — Cryptographic primitives (Node.js crypto encapsulated)
│   ├── generateToken()                  → random URL-safe access token
│   ├── generateOtp()                    → 6-digit OTP via crypto.randomInt()
│   ├── hashOtp(otp)                     → SHA-256 hex digest for DB storage
│   ├── verifyOtp(plaintext, hash)       → timing-safe comparison
│   ├── buildSigningLink(baseUrl, token) → full signer URL
│   └── generateAuthenticationId(...)    → deterministic auth ID from signing metadata
│
└── NotificationService.ts  — Email templates, webhook dispatch
    ├── sendSigningInvitation(...)        → initial signing invitation email
    ├── sendResendInvitation(...)         → follow-up reminder email
    ├── sendReplyNotification(...)        → admin reply to signer query
    ├── sendOtpEmail(...)                → OTP verification code email
    ├── sendQueryNotification(...)        → forward signer query to firm
    ├── sendCompletionNotifications(...)  → all-signed notification emails
    ├── dispatchWebhook(url, payload)     → HMAC-signed webhook with retries
    ├── loadEmailSettings()              → reads email copy from DB settings
    └── getGmailProfile()               → re-exported Gmail profile helper
```

### Middleware Layer
```
server/middleware/
├── asyncHandler.ts         — Wraps async route handlers; forwards errors to global handler via next(err)
└── validators.ts           — validateId middleware; parses :id param, returns 400 if invalid
```

### Design Rules
- Route handlers must not import `pdf-lib`, `crypto`, or construct email templates directly
- All async route handlers must be wrapped in `asyncHandler()`
- All `:id` routes must use `validateId` middleware
- `routes.ts` must remain under 1,000 lines (currently ~915 lines, reduced from 1,355)
- See `ARCHISIGN_ARCHITECTURE.md` for full enforcement rules and AI agent directives

## 10. Security Hardening

### Refactoring Phase 5 — Webhook Security (Completed)
- HMAC SHA-256 signing on all outbound webhooks via `x-archisign-signature` header
- Exponential backoff retries (3 attempts, 1s/3s delays, 10s timeout per attempt)
- Non-retryable 4xx responses fail immediately
- Backward compatible: unsigned if `ARCHISIGN_WEBHOOK_SECRET` not configured

### Refactoring Phase 4 — Middleware Extraction (Completed)
- `asyncHandler` wrapper eliminates 29 repetitive try/catch blocks
- `validateId` middleware eliminates 7 inline parseInt/isNaN checks
- Global Express error handler in `index.ts` catches all forwarded errors
- `routes.ts` reduced from 1,355 to 915 lines (32.5% reduction)

### Refactoring Phase 3 — NotificationService Extraction (Completed)
- All email templates and webhook dispatch extracted to `NotificationService.ts`
- `loadEmailSettings()`, `wrapEmail()`, `escapeHtml()` moved out of routes
- `routes.ts` reduced from 1,257 to 1,044 lines

### Refactoring Phase 2 — SecurityService Extraction (Completed)
- All cryptographic primitives extracted to `SecurityService.ts`
- Timing-safe OTP verification via `crypto.timingSafeEqual`
- `routes.ts` reduced from 1,269 to 1,257 lines

### Refactoring Phase 1 — PdfService Extraction (Completed)
- All pdf-lib operations extracted to `PdfService.ts`
- Pure, testable functions for page counting and PDF stamping
- `routes.ts` reduced from 1,355 to 1,269 lines

### Infrastructure Phase 4 — Persistent File Storage
- All PDFs and backups stored in Replit Object Storage (GCS-backed)
- Files persist across deployments and container restarts
- `fileStorage.ts` abstraction layer with automatic bucket/prefix parsing
- Multer temp files cleaned up in `finally` blocks (guaranteed cleanup)
- Streaming file serving — no full-file buffering in memory

### Infrastructure Phase 1 — Input & Output Safety
- Path traversal protection on `/uploads` (filename validation, `..` and `/` rejection)
- OTP generation via `crypto.randomInt()` + SHA-256 hashing
- Async file I/O throughout (fs/promises for temp files only)
- Log sanitization: accessToken, otpCode, otpExpiresAt redacted

### Infrastructure Phase 2 — Data Integrity
- ACID transactions for envelope creation and signing flows
- N+1 query elimination with batch fetching (inArray)
- Atomic double-sign prevention (conditional UPDATE WHERE signedAt IS NULL)
- Clean transaction boundaries (file I/O outside transactions, cleanup on failure)

### Infrastructure Phase 3 — Robustness
- Zod schema validation on all input-accepting routes
- Graceful shutdown (SIGTERM/SIGINT, 10-second forced exit)
- Email failure safety (envelope stays draft if all sends fail)
- Webhook error isolation (try/catch, timeout, logging)

## 11. Frontend Structure

```
client/src/
├── pages/
│   ├── dashboard.tsx        — Admin envelope list with status filters (10s auto-refresh)
│   ├── envelope-new.tsx     — Create envelope form (PDF upload + signers)
│   ├── envelope-detail.tsx  — Envelope detail (overview, signers, comms, audit tabs)
│   ├── signer-verify.tsx    — External OTP verification page
│   ├── signer-document.tsx  — Document signing interface (page-by-page initials + final signature)
│   ├── settings.tsx         — Admin settings (email templates, firm name)
│   ├── rollback-ledger.tsx  — Version tracking ledger
│   ├── data-recovery.tsx    — Deleted envelope recovery + backup management
│   ├── pre-deployment.tsx   — Pre-deployment audit checklist
│   └── login.tsx            — Split-screen login (Replit Auth)
├── components/
│   ├── app-sidebar.tsx      — Navigation sidebar (logo, menu, user info, logout)
│   ├── theme-toggle.tsx     — Dark/light mode toggle
│   └── ui/                  — Shadcn UI component library
├── hooks/
│   ├── use-auth.ts          — Authentication state hook
│   └── use-toast.ts         — Toast notification hook
└── lib/
    ├── auth-utils.ts        — Auth error utilities
    ├── queryClient.ts       — TanStack Query client config
    └── theme-provider.tsx   — Theme context provider
```

## 12. Server Structure

```
server/
├── index.ts                 — Express app setup (25MB JSON limit, graceful shutdown, global error handler)
├── routes.ts                — API route definitions (~915 lines, thin traffic controller)
├── storage.ts               — Database storage layer (IStorage interface)
├── fileStorage.ts           — Object Storage abstraction (upload/download/stream/delete)
├── db.ts                    — Drizzle/PostgreSQL connection
├── gmail.ts                 — Gmail API integration (send email, get profile)
├── seed.ts                  — Email settings seeder (7 default settings)
├── middleware/
│   ├── asyncHandler.ts      — Async route handler wrapper (forwards errors via next())
│   └── validators.ts        — Route param validators (validateId middleware)
├── services/
│   ├── PdfService.ts        — PDF manipulation (getPageCount, stampSignedPdf)
│   ├── SecurityService.ts   — Crypto primitives (tokens, OTP, HMAC, signing links)
│   └── NotificationService.ts — Email templates, HMAC webhook dispatch with retries
└── replit_integrations/
    ├── auth/                — Replit Auth OIDC module (passport, sessions, user storage)
    └── object_storage/      — Object Storage client (GCS credentials, ACL, signed URLs)

shared/
├── schema.ts                — Drizzle models + Zod schemas + relations
└── models/auth.ts           — Users + sessions tables (Replit Auth)
```

## 13. Environment Variables & Secrets

| Variable                        | Type   | Required | Description                                      |
|---------------------------------|--------|----------|--------------------------------------------------|
| DATABASE_URL                    | env    | Yes      | PostgreSQL connection string (auto-provided)     |
| ARCHIDOC_API_KEY                | secret | Yes      | API key for ArchiDoc service-to-service auth     |
| ARCHISIGN_WEBHOOK_SECRET        | secret | No       | HMAC SHA-256 secret for webhook payload signing  |
| ADMIN_EMAILS                    | env    | No       | Comma-separated allowlist of admin emails        |
| ISSUER_URL                      | env    | Auto     | Replit Auth OIDC issuer (auto-configured)        |
| DEFAULT_OBJECT_STORAGE_BUCKET_ID| secret | Auto     | Object Storage bucket ID (auto-configured)       |
| PRIVATE_OBJECT_DIR              | secret | Auto     | Object Storage private directory path            |
| PUBLIC_OBJECT_SEARCH_PATHS      | secret | Auto     | Object Storage public search paths               |
| SESSION_SECRET                  | secret | Auto     | Express session secret (auto-configured)         |

## 14. Deployment

- Hosted on Replit with automatic HTTPS via `.replit.app` domain
- Frontend and backend served on the same port (5000) via Vite middleware
- PostgreSQL database auto-provisioned by Replit
- PDF and backup files stored in Replit Object Storage (GCS-backed, persistent)
- Publish via Replit's built-in deployment tooling
- Graceful shutdown handling for zero-downtime deploys
