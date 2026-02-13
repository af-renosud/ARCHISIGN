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
│                    ┌────────┴────────┐                          │
│                    │                 │                          │
│              ┌─────▼─────┐   ┌──────▼──────┐                  │
│              │ Gmail API │   │ File Storage │                  │
│              │ (Replit   │   │  (uploads/)  │                  │
│              │ Connector)│   │              │                  │
│              └───────────┘   └─────────────┘                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
         ▲                              ▲
         │ OIDC Auth                    │ REST API + Webhooks
         │ (Admin Login)                │
    ┌────┴─────┐                  ┌─────┴──────┐
    │  Replit   │                  │  ArchiDoc  │
    │  Auth     │                  │  (Service) │
    └──────────┘                  └────────────┘
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
    ├── annotations (id, envelopeId FK, signerEmail, pageNumber,
    │                type, dataUrl, x, y, width, height, timestamp)
    │
    ├── communication_logs (id, envelopeId FK, direction, senderEmail,
    │                       recipientEmail, subject, body, gmailMessageId, timestamp)
    │
    └── audit_events (id, envelopeId FK nullable, eventType, actorEmail,
                      ipAddress, metadata, timestamp)

settings (key PK, value)
rollback_versions (id, label, note, status, createdAt)
backups (id, filename, createdAt)
users (id, email, firstName, lastName, profileImageUrl, createdAt, updatedAt)
sessions (sid PK, sess, expire)
```

### Key Design Decisions
- `envelopes.deletedAt` enables soft-delete for data recovery
- `audit_events.envelopeId` is nullable to support system-level events (auth attempts)
- `signers.otpCode` stores SHA-256 hash, never plaintext
- `signers.accessToken` is a cryptographic random hex string for tokenized URLs
- Foreign keys use CASCADE delete for referential integrity

## 5. Authentication & Authorization

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
                              ├─ /uploads           → PASS (static files)
                              └─ /api/*             → REQUIRE OIDC + allowlist
```

## 6. API Routes

### Admin Routes (require OIDC auth)
| Method | Path                              | Description                    |
|--------|-----------------------------------|--------------------------------|
| GET    | /api/envelopes                    | List all envelopes             |
| GET    | /api/envelopes/:id                | Get envelope detail            |
| POST   | /api/envelopes                    | Create new envelope            |
| POST   | /api/envelopes/:id/signers        | Add signer to envelope         |
| POST   | /api/envelopes/:id/send           | Send envelope for signing      |
| POST   | /api/envelopes/:id/upload-pdf     | Upload PDF to envelope         |
| DELETE | /api/envelopes/:id                | Soft-delete envelope           |
| POST   | /api/envelopes/:id/restore        | Restore soft-deleted envelope  |
| GET    | /api/settings                     | Get all settings               |
| PUT    | /api/settings                     | Update settings                |
| GET    | /api/auth/user                    | Get authenticated user info    |

### External Signer Routes (public, token-authenticated)
| Method | Path                              | Description                    |
|--------|-----------------------------------|--------------------------------|
| GET    | /api/sign/:token/info             | Get signer + envelope info     |
| POST   | /api/sign/:token/request-otp      | Send OTP to signer email       |
| POST   | /api/sign/:token/verify-otp       | Verify OTP code                |
| POST   | /api/sign/:token/annotate         | Save page annotation           |
| POST   | /api/sign/:token/sign             | Final signature submission     |
| POST   | /api/sign/:token/query            | Send clarification query       |

### ArchiDoc API (API key authenticated)
| Method | Path                              | Description                    |
|--------|-----------------------------------|--------------------------------|
| POST   | /api/v1/envelopes/create          | Create envelope via API        |

## 7. ArchiDoc Integration

### Inbound (ArchiDoc → ArchiSign)
- `POST /api/v1/envelopes/create` with `X-API-KEY` header
- Accepts `pdfBase64` (base64-encoded PDF, decoded and saved to `uploads/`)
- Accepts `signers` array `[{email, fullName}]` for multi-signer envelopes
- Backward compatible with legacy `signerEmail`/`signerName` fields
- Returns full envelope object with signer details
- JSON body limit: 25MB (supports architectural documents up to ~18MB)

### Outbound (ArchiSign → ArchiDoc)
- Webhook callbacks to `webhookUrl` on status changes
- Payload: `{envelopeId, status, timestamp}`
- Statuses: `sent`, `viewed`, `queried`, `signed`
- 10-second timeout with error logging

## 8. Security Hardening

### Phase 1 — Input & Output Safety
- Path traversal protection on `/uploads` (path.resolve + prefix check)
- OTP generation via `crypto.randomInt()` + SHA-256 hashing
- Async file I/O throughout (fs/promises)
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

## 9. Frontend Structure

```
client/src/
├── pages/
│   ├── dashboard.tsx        — Admin envelope list with status filters
│   ├── envelope-new.tsx     — Create envelope form
│   ├── envelope-detail.tsx  — Envelope detail (overview, signers, comms, audit tabs)
│   ├── signer-verify.tsx    — External OTP verification page
│   ├── signer-document.tsx  — Document signing interface (page-by-page)
│   ├── settings.tsx         — Admin settings (email templates)
│   ├── rollback-ledger.tsx  — Version tracking ledger
│   ├── data-recovery.tsx    — Deleted envelope recovery + backups
│   ├── pre-deployment.tsx   — Pre-deployment audit checklist
│   └── login.tsx            — Split-screen login (Replit Auth)
├── components/
│   ├── app-sidebar.tsx      — Navigation sidebar (logo, menu, user info, logout)
│   ├── theme-toggle.tsx     — Dark/light mode toggle
│   └── ui/                  — Shadcn UI component library
├── hooks/
│   └── use-auth.ts          — Authentication state hook
└── lib/
    ├── auth-utils.ts        — Auth error utilities
    ├── queryClient.ts       — TanStack Query client config
    └── theme-provider.tsx   — Theme context provider
```

## 10. Environment Variables & Secrets

| Variable          | Type   | Required | Description                                      |
|-------------------|--------|----------|--------------------------------------------------|
| DATABASE_URL      | env    | Yes      | PostgreSQL connection string (auto-provided)     |
| ARCHIDOC_API_KEY  | secret | Yes      | API key for ArchiDoc service-to-service auth     |
| ADMIN_EMAILS      | env    | No       | Comma-separated allowlist of admin emails        |
| ISSUER_URL        | env    | Auto     | Replit Auth OIDC issuer (auto-configured)        |

## 11. Deployment

- Hosted on Replit with automatic HTTPS via `.replit.app` domain
- Frontend and backend served on the same port (5000) via Vite middleware
- PostgreSQL database auto-provisioned by Replit
- File uploads stored in `uploads/` directory
- Publish via Replit's built-in deployment tooling
