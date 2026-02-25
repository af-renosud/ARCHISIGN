# ARCHISIGN Architecture & Engineering Standards

> **Canonical reference for all contributors and AI agents.**
> Last updated after completion of the 5-phase surgical refactoring of the Archisign e-signature platform.

---

## 1. PDF Manipulation — `PdfService`

**Rule:** Never import `pdf-lib` directly into a route handler.

- All PDF loading, page counting, coordinate math, and document stamping must be encapsulated as pure, testable functions inside `server/services/PdfService.ts`.
- The service exposes two public functions:
  - `getPageCount(pdfBytes: Buffer): Promise<number>` — extracts the total page count from a PDF buffer.
  - `stampSignedPdf(pdfBytes: Buffer, signersWithAnnotations, envelopeId): Promise<{ signedPdfBytes: Uint8Array }>` — stamps initials, signatures, and an authentication footer onto every page of the document.
- Route handlers receive raw PDF bytes (from uploads or Object Storage) and pass them to `PdfService`. They never manipulate PDF internals directly.

---

## 2. Cryptography & Security — `SecurityService`

**Rule:** Never generate tokens, hash OTPs, or build signing links inline.

- All cryptographic primitives must live inside `server/services/SecurityService.ts`.
- The service exposes:
  - `generateToken(): string` — produces a cryptographically random URL-safe access token.
  - `generateOtp(): string` — produces a 6-digit OTP via `crypto.randomInt()`.
  - `hashOtp(otp: string): string` — returns a SHA-256 hex digest of the OTP for database storage.
  - `verifyOtp(plaintext: string, storedHash: string): boolean` — performs timing-safe comparison using `crypto.timingSafeEqual` to prevent timing attacks.
  - `buildSigningLink(baseUrl: string, token: string): string` — constructs the full signer-facing URL.
  - `generateAuthenticationId(signerId: number, envelopeId: number, signedAt: Date): string` — derives a deterministic authentication identifier from signing metadata.
- The SHA-256 algorithm is the project standard. Do not change it without a documented migration plan.

---

## 3. Side-Effects & Notifications — `NotificationService`

**Rule:** Never configure email transports or dispatch raw `fetch` webhooks inside a route handler.

- All emails and webhooks must be dispatched through `server/services/NotificationService.ts`.
- **Email functions** (all accept signer/envelope context and an `EmailSettings` config object):
  - `sendSigningInvitation` — initial signing invitation email.
  - `sendResendInvitation` — follow-up reminder to pending signers.
  - `sendReplyNotification` — admin reply to a signer query.
  - `sendOtpEmail` — OTP verification code delivery.
  - `sendQueryNotification` — forwards a signer's clarification request to the firm.
  - `sendCompletionNotifications` — notifies all parties when an envelope is fully signed.
- **Webhook dispatch** (`dispatchWebhook`):
  - Payloads are signed with HMAC SHA-256 using `ARCHISIGN_WEBHOOK_SECRET` (when configured) and attached via the `x-archisign-signature` header.
  - Delivery uses exponential backoff with up to 3 attempts (1s, 3s delays) and a 10-second timeout per attempt.
  - Only 5xx responses and network errors trigger retries; 4xx client errors fail immediately.
- **Shared utilities** exported from the service:
  - `loadEmailSettings()` — reads email copy text from the database settings table.
  - `getGmailProfile()` — re-exported from the Gmail module for convenience.

---

## 4. Route Handlers & Middleware

**Rule:** Never write repetitive try/catch blocks or inline `req.params` parsing in route handlers.

- **`server/middleware/asyncHandler.ts`** — All async route handlers must be wrapped in `asyncHandler()`. This forwards any thrown error to the global Express error handler in `server/index.ts` via `next(err)`, eliminating boilerplate try/catch blocks.
- **`server/middleware/validators.ts`** — All routes with an `:id` parameter must use the `validateId` middleware. It parses, validates, and attaches the numeric ID to `(req as any).validatedId`, returning 400 for invalid values.
- **`server/routes.ts`** must remain **under 1,000 lines** and act purely as a traffic controller:
  - Parse and validate input.
  - Call storage, services, or middleware.
  - Return the response.
  - It must not contain PDF logic, email templates, cryptographic operations, or raw webhook dispatching.
- Internal try/catch blocks are permitted only for **intentional graceful degradation** (e.g., catching email send failures to avoid blocking the signing flow, or catching PDF stamping errors to avoid losing the signed status).

---

## 5. Storage & Data Access

- All database CRUD operations go through the `IStorage` interface in `server/storage.ts`.
- Route handlers never import `db` directly except for `db.transaction()` calls that require transactional integrity across multiple storage operations.
- Types for all models are defined in `shared/schema.ts` using Drizzle ORM schemas with corresponding Zod validation schemas.

---

## 6. File Storage

- All file operations (PDFs and backups) use the abstraction layer in `server/fileStorage.ts`.
- Files are stored in Replit Object Storage (GCS-backed), persistent across deployments.
- Path traversal is prevented at the route level: filenames containing `..` or `/` are rejected.
- Large PDFs are streamed via `streamFileToResponse` — never buffered entirely in memory for serving.

---

## 7. Authentication & Authorization

- **Admin area:** Replit Auth (OIDC) with optional `ADMIN_EMAILS` allowlist.
- **External signers:** Token-based access (`/api/sign/:token/*`) with OTP verification — no session required.
- **Service-to-service:** API key validation (`X-API-KEY` header) for `/api/v1/*` routes against `ARCHIDOC_API_KEY`.
- Unauthorized access attempts are logged to the `audit_events` table.

---

## AI Agent Instructions

Before proposing any code changes, new routes, or security modifications, you **MUST** read this file.

You are strictly forbidden from:

- Placing PDF logic (`pdf-lib` imports, page counting, document stamping) directly inside Express route handlers. Use `PdfService`.
- Placing email dispatching (template construction, SMTP/Gmail calls) directly inside Express route handlers. Use `NotificationService`.
- Placing cryptographic hashing, token generation, or OTP operations directly inside Express route handlers. Use `SecurityService`.
- Placing raw `fetch` calls for webhook delivery directly inside Express route handlers. Use `dispatchWebhook` from `NotificationService`.
- Writing bare `try { ... } catch (err) { res.status(500).json(...) }` blocks. Use `asyncHandler`.
- Writing inline `parseInt(req.params.id)` + `isNaN` checks. Use `validateId` middleware.

When adding new functionality:

1. Determine which service layer owns the logic.
2. Add the function to the appropriate service with a clear, testable interface.
3. Call it from the route handler, which should remain a thin orchestrator.
4. Keep `server/routes.ts` under 1,000 lines.
