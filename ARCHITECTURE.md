# Archisign — Architecture Document

## 1. System Overview

Archisign is a specialized e-signature platform built for a French architecture firm (Ma&icirc;tre d'&OElig;uvre). It handles external sign-offs from clients, contractors, and partners on architectural plans and contracts. The system provides a secure, tokenized signing workflow with OTP verification, audit trails, and Gmail integration for communications.

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
│                    ┌────────┼────────┐                          │
│                    │        │        │                          │
│              ┌─────▼─────┐ │ ┌──────▼──────┐                  │
│              │ Gmail API │ │ │   Object    │                  │
│              │ (Replit   │ │ │   Storage   │                  │
│              │ Connector)│ │ │  (GCS-backed)│                  │
│              └───────────┘ │ └─────────────┘                  │
│                            │                                   │
└────────────────────────────┼───────────────────────────────────┘
         ▲                   │                    ▲
         │ OIDC Auth         │                    │ REST API + Webhooks
         │ (Admin Login)     │                    │
    ┌────┴─────┐             │             ┌─────┴──────┐
    │  Replit   │             │             │  ArchiDoc  │
    │  Auth     │             │             │  (Service) │
    └──────────┘             │             └────────────┘
                             │
                    ┌────────▼────────┐
                    │  Replit Object  │
                    │    Storage     │
                    │  (persistent   │
                    │   GCS bucket)  │
                    └────────────────┘
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
| PDF         | pdf-lib                                  |
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
    │                       recipientEmail, subject, body, gmailMessageId, createdAt)
    │
    └── audit_events (id, envelopeId FK nullable, eventType, actorEmail,
                      ipAddress, metadata, createdAt)

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

### Outbound (Archisign → ArchiDoc)
- Webhook callbacks to `webhookUrl` on status changes
- Payload: `{event, envelopeId, externalRef, status}`
- Events: `envelope.sent`, `envelope.viewed`, `envelope.queried`, `envelope.signed`
- 10-second timeout with error logging

## 9. Security Hardening

### Phase 4 — Persistent File Storage
- All PDFs and backups stored in Replit Object Storage (GCS-backed)
- Files persist across deployments and container restarts
- `fileStorage.ts` abstraction layer with automatic bucket/prefix parsing
- Multer temp files cleaned up in `finally` blocks (guaranteed cleanup)
- Streaming file serving — no full-file buffering in memory

### Phase 1 — Input & Output Safety
- Path traversal protection on `/uploads` (filename validation, `..` and `/` rejection)
- OTP generation via `crypto.randomInt()` + SHA-256 hashing
- Async file I/O throughout (fs/promises for temp files only)
- Log sanitization: accessToken, otpCode, otpExpiresAt redacted

### Phase 2 — Data Integrity
- ACID transactions for envelope creation and signing flows
- N+1 query elimination with batch fetching (inArray)
- Atomic double-sign prevention (conditional UPDATE WHERE signedAt IS NULL)
- Clean transaction boundaries (file I/O outside transactions, cleanup on failure)

### Phase 3 — Robustness
- Zod schema validation on all input-accepting routes
- Graceful shutdown (SIGTERM/SIGINT, 10-second forced exit)
- Email failure safety (envelope stays draft if all sends fail)
- Webhook error isolation (try/catch, timeout, logging)

## 10. Frontend Structure

```
client/src/
├── pages/
│   ├── dashboard.tsx        — Admin envelope list with status filters (30s auto-refresh)
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

## 11. Server Structure

```
server/
├── index.ts                 — Express app setup (25MB JSON limit, graceful shutdown)
├── routes.ts                — All API endpoints (admin auth middleware)
├── storage.ts               — Database storage layer (IStorage interface)
├── fileStorage.ts           — Object Storage abstraction (upload/download/stream/delete)
├── db.ts                    — Drizzle/PostgreSQL connection
├── gmail.ts                 — Gmail API integration (send email, get profile)
├── seed.ts                  — Email settings seeder (7 default settings)
└── replit_integrations/
    ├── auth/                — Replit Auth OIDC module (passport, sessions, user storage)
    └── object_storage/      — Object Storage client (GCS credentials, ACL, signed URLs)

shared/
├── schema.ts                — Drizzle models + Zod schemas + relations
└── models/auth.ts           — Users + sessions tables (Replit Auth)
```

## 12. Environment Variables & Secrets

| Variable                        | Type   | Required | Description                                      |
|---------------------------------|--------|----------|--------------------------------------------------|
| DATABASE_URL                    | env    | Yes      | PostgreSQL connection string (auto-provided)     |
| ARCHIDOC_API_KEY                | secret | Yes      | API key for ArchiDoc service-to-service auth     |
| ADMIN_EMAILS                    | env    | No       | Comma-separated allowlist of admin emails        |
| ISSUER_URL                      | env    | Auto     | Replit Auth OIDC issuer (auto-configured)        |
| DEFAULT_OBJECT_STORAGE_BUCKET_ID| secret | Auto     | Object Storage bucket ID (auto-configured)       |
| PRIVATE_OBJECT_DIR              | secret | Auto     | Object Storage private directory path            |
| PUBLIC_OBJECT_SEARCH_PATHS      | secret | Auto     | Object Storage public search paths               |
| SESSION_SECRET                  | secret | Auto     | Express session secret (auto-configured)         |

## 13. Deployment

- Hosted on Replit with automatic HTTPS via `.replit.app` domain
- Frontend and backend served on the same port (5000) via Vite middleware
- PostgreSQL database auto-provisioned by Replit
- PDF and backup files stored in Replit Object Storage (GCS-backed, persistent)
- Publish via Replit's built-in deployment tooling
- Graceful shutdown handling for zero-downtime deploys
