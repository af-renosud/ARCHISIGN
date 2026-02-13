import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Database, Shield, Link2, Copy, Check, ChevronLeft, CheckCircle2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";

const DATABASE_AUDIT_PROMPT = `## ARCHISIGN — DATABASE AUDIT (Pre-Deployment)

Run a full database audit on the Archisign e-signature platform before deployment.

### 1. Schema Sync Verification
- Compare the Drizzle ORM schema in \`shared/schema.ts\` and \`shared/models/auth.ts\` against the live PostgreSQL database
- Verify all 10 tables exist: \`envelopes\`, \`signers\`, \`annotations\`, \`communication_logs\`, \`audit_events\`, \`settings\`, \`rollback_versions\`, \`backups\`, \`users\`, \`sessions\`
- Verify all 3 enum types exist: \`envelope_status\` (draft, sent, viewed, queried, signed, declined), \`annotation_type\` (initial, signature, date), \`rollback_version_status\` (active, superseded)
- Confirm every column matches its Drizzle definition (type, default, nullability):
  - \`envelopes\`: id (identity PK), external_ref (text nullable), subject (text NOT NULL), message (text nullable), status (envelope_status default 'draft'), original_pdf_url (text nullable), signed_pdf_url (text nullable), total_pages (int default 1), webhook_url (text nullable), gmail_thread_id (text nullable), created_at (timestamp defaultNow), updated_at (timestamp defaultNow), deleted_at (timestamp nullable)
  - \`signers\`: id (identity PK), envelope_id (int NOT NULL FK), email (text NOT NULL), full_name (text NOT NULL), access_token (text NOT NULL UNIQUE), otp_code (text nullable), otp_expires_at (timestamp nullable), otp_verified (boolean default false), last_viewed_at (timestamp nullable), signed_at (timestamp nullable)
  - \`annotations\`: id (identity PK), envelope_id (int NOT NULL FK), signer_id (int NOT NULL FK), page_number (int NOT NULL), x_pos (real NOT NULL), y_pos (real NOT NULL), type (annotation_type NOT NULL), value (text nullable), created_at (timestamp defaultNow)
  - \`communication_logs\`: id (identity PK), envelope_id (int NOT NULL FK), sender_email (text NOT NULL), message_body (text NOT NULL), is_external_query (boolean default false), gmail_message_id (text nullable), timestamp (timestamp defaultNow)
  - \`audit_events\`: id (identity PK), envelope_id (int NULLABLE FK), event_type (text NOT NULL), actor_email (text nullable), ip_address (text nullable), metadata (text nullable), timestamp (timestamp defaultNow)
  - \`settings\`: key (text PK), value (text NOT NULL), label (text NOT NULL), category (text NOT NULL default 'general')
  - \`rollback_versions\`: id (identity PK), version_label (text NOT NULL), note (text nullable), status (rollback_version_status default 'active'), created_at (timestamp defaultNow)
  - \`backups\`: id (identity PK), filename (text NOT NULL), created_at (timestamp defaultNow)
  - \`users\`: id (varchar PK default \`gen_random_uuid()\`), email (varchar UNIQUE nullable), first_name (varchar nullable), last_name (varchar nullable), profile_image_url (varchar nullable), created_at (timestamp defaultNow), updated_at (timestamp defaultNow)
  - \`sessions\`: sid (varchar PK), sess (jsonb NOT NULL), expire (timestamp NOT NULL)
- Check that \`generatedAlwaysAsIdentity()\` is correctly applied on all ID columns (envelopes, signers, annotations, communication_logs, audit_events, rollback_versions, backups)
- Verify \`sessions\` has an index on \`expire\` column (\`IDX_session_expire\`)

### 2. Foreign Key & Cascade Verification
- Verify FK constraints with ON DELETE CASCADE:
  - \`signers.envelope_id → envelopes.id\`
  - \`annotations.envelope_id → envelopes.id\`
  - \`annotations.signer_id → signers.id\`
  - \`communication_logs.envelope_id → envelopes.id\`
  - \`audit_events.envelope_id → envelopes.id\` (NULLABLE — CASCADE applies when envelope_id is not null; rows with null envelope_id are system-level auth events and are not affected by envelope deletion)
- Test: hard-deleting an envelope should cascade-delete its signers, annotations, communication_logs, and audit_events (where envelope_id matches)
- Verify \`settings\`, \`rollback_versions\`, \`backups\`, \`users\`, and \`sessions\` are standalone tables with no FK dependencies

### 3. Unique Constraints & Indexes
- Verify \`signers.access_token\` has a UNIQUE constraint (used for tokenized signer URLs)
- Verify \`settings.key\` is the primary key (used for upsert via onConflictDoUpdate)
- Verify \`users.email\` has a UNIQUE constraint
- Verify \`sessions\` has an index on \`expire\` (\`IDX_session_expire\`)
- Check for missing indexes on frequently queried columns: \`signers.envelope_id\`, \`annotations.envelope_id\`, \`annotations.signer_id\`, \`communication_logs.envelope_id\`, \`audit_events.envelope_id\`

### 4. Orphaned Records Check
- Query for signers with no matching envelope
- Query for annotations with no matching signer or envelope
- Query for communication_logs with no matching envelope
- Query for audit_events with no matching envelope WHERE \`envelope_id IS NOT NULL\` — audit_events with null \`envelope_id\` are NOT orphans (they are system-level auth events such as unauthorized admin access attempts)
- Report any orphaned data found

### 5. Soft-Delete Integrity
- Verify GET \`/api/envelopes\` filters by \`WHERE deleted_at IS NULL\`
- Verify GET \`/api/envelopes/deleted\` filters by \`WHERE deleted_at IS NOT NULL\`
- Verify POST \`/api/envelopes/:id/soft-delete\` sets \`deleted_at\` to current timestamp
- Verify POST \`/api/envelopes/:id/restore\` clears \`deleted_at\` back to NULL
- Confirm child records (signers, annotations, logs, events) are NOT affected by soft-delete

### 6. Destructive Changes Detection
- Run \`npm run db:push\` in dry-run mode and check output for destructive ALTER TABLE statements
- NEVER run \`db:push --force\` on production without explicit approval
- Flag any column type changes, dropped columns, or renamed tables
- Verify no enum value removals (only additions are safe)

### 7. Secrets & Connection Safety
- Verify DATABASE_URL environment variable is set and reachable
- Verify \`ARCHIDOC_API_KEY\` secret is set (required for ArchiDoc API authentication on \`/api/v1/*\` routes)
- Verify connection pool (\`@neondatabase/serverless\` Pool) is healthy with no stale connections
- Confirm graceful shutdown in \`server/index.ts\` calls \`pool.end()\` to close connections
- Confirm no database credentials are hardcoded in source files

### Output Format
For each check, report: PASS, WARN (with explanation), or FAIL (with remediation steps).
End with: **GO** (ready for deployment) or **NO-GO** (with blocking issues listed).`;

const APPLICATION_AUDIT_PROMPT = `## ARCHISIGN — APPLICATION AUDIT (Pre-Deployment)

Run a full application code and security audit on the Archisign e-signature platform before deployment.

### 1. Build Verification
- Run \`npm run build\` and confirm it completes without errors
- Check TypeScript compilation (\`npm run check\`) for type errors
- Verify the production entry point \`dist/index.cjs\` is generated correctly
- Confirm Vite frontend build produces valid output in \`dist/public/\`

### 2. API Route Integrity (27 endpoints)
- Verify all API routes in \`server/routes.ts\` are reachable and return proper status codes:
  - **Envelope CRUD**: GET \`/api/envelopes\` (list active), POST \`/api/envelopes\` (create with multipart/form-data PDF upload), GET \`/api/envelopes/:id\` (detail with signers, logs, events)
  - **Envelope Actions**: POST \`/api/envelopes/:id/send\` (send invitations), POST \`/api/envelopes/:id/reply\` (reply to query)
  - **Soft-Delete**: GET \`/api/envelopes/deleted\`, POST \`/api/envelopes/:id/soft-delete\`, POST \`/api/envelopes/:id/restore\`
  - **Signer Flow**: GET \`/api/sign/:token/info\`, POST \`/api/sign/:token/request-otp\`, POST \`/api/sign/:token/verify-otp\`, GET \`/api/sign/:token/document\`, POST \`/api/sign/:token/initial\`, POST \`/api/sign/:token/query\`, POST \`/api/sign/:token/sign\`
  - **ArchiDoc API**: POST \`/api/v1/envelopes/create\` — service-to-service envelope creation with \`X-API-KEY\` header auth validated against \`ARCHIDOC_API_KEY\` secret. Accepts \`pdfBase64\` (base64-encoded PDF, decoded and saved to \`uploads/\`, page count extracted via pdf-lib). Supports \`signers\` array \`[{email, fullName}]\` for multi-signer envelopes, with backward-compatible legacy \`signerEmail\`/\`signerName\` fields. Validated by \`createApiEnvelopeRequestSchema\` Zod schema with \`.refine()\` ensuring at least one signer source is provided.
  - **Settings**: GET \`/api/settings\` (all), GET \`/api/settings/:key\` (single), PUT \`/api/settings\` (bulk upsert array)
  - **Rollback Versions**: GET \`/api/rollback-versions\`, POST \`/api/rollback-versions\`, PATCH \`/api/rollback-versions/:id\`, DELETE \`/api/rollback-versions/:id\`
  - **Backups**: GET \`/api/backups\`, POST \`/api/backups\` (create JSON backup), GET \`/api/backups/:id/download\`, DELETE \`/api/backups/:id\`
  - **Static Files**: GET \`/uploads/*\` (path-traversal-protected file serving)
- Verify proper error handling (400/404/500 responses) on each route
- Check that input-accepting routes validate via Zod schemas: \`createEnvelopeRequestSchema\`, \`createSignerRequestSchema\`, \`createApiEnvelopeRequestSchema\` (with \`.refine()\`), \`insertRollbackVersionSchema\`

### 3. Authentication & Authorization
- Verify Replit Auth OIDC is configured (\`ISSUER_URL\` env var auto-set by Replit)
- Verify \`setupAuth()\` and \`registerAuthRoutes()\` are called in \`registerRoutes()\` before admin middleware
- Verify admin middleware (\`isAdminAuthorized\`) protects all \`/api/*\` routes except:
  - \`/api/sign/:token/*\` — public signer flow (bypassed)
  - \`/api/v1/*\` — ArchiDoc API (authenticated via \`X-API-KEY\` header)
  - \`/api/login\`, \`/api/logout\`, \`/api/callback\`, \`/api/auth/*\` — OIDC auth flow routes
  - \`/uploads\` — static file serving
- Verify \`ADMIN_EMAILS\` allowlist enforcement: when set (comma-separated), only listed emails can access admin \`/api/*\` routes; unauthorized attempts return 403
- Verify unauthorized admin access attempts create \`audit_events\` with null \`envelopeId\`, event type "Unauthorized admin access attempt", actor email, IP, and path/method metadata
- Verify API key validation on \`/api/v1/*\` routes: \`X-API-KEY\` header checked against \`ARCHIDOC_API_KEY\` secret; returns 401 if invalid; logs warning if \`ARCHIDOC_API_KEY\` is not configured
- Verify session storage uses PostgreSQL via \`connect-pg-simple\` (\`sessions\` table with \`sid\`, \`sess\`, \`expire\` columns)
- Verify user profiles are upserted into \`users\` table on OIDC login

### 4. Security Checks
- Confirm no secrets (DATABASE_URL, Gmail tokens, \`ARCHIDOC_API_KEY\`) are hardcoded in source code
- Verify signing tokens generated with \`crypto.randomBytes(32).toString("hex")\` (64-char hex, cryptographically secure)
- Verify OTP generation uses \`crypto.randomInt(100000, 1000000)\` (6-digit, uniform distribution)
- Verify OTPs are SHA-256 hashed via \`createHash("sha256")\` before DB storage — raw OTP never persisted
- Verify OTP codes expire after 10 minutes (\`Date.now() + 10 * 60 * 1000\`) and otp_code + otp_expires_at are cleared to NULL after successful verification
- Check that signer document/initial/sign/query endpoints all require \`otpVerified === true\` (403 if not)
- Verify log redaction in \`server/index.ts\`: SENSITIVE_KEYS set includes accessToken, access_token, otpCode, otp_code, otpExpiresAt, otp_expires_at, token, password, secret, authorization — all redacted to "[REDACTED]" in response logs
- Verify file upload: multer configured with PDF-only MIME filter and 50MB size limit
- Verify path traversal protection on \`/uploads\` route: \`path.resolve()\` + prefix check against uploads directory
- Verify \`/api/sign/:token/sign\` endpoint checks \`signer.signedAt\` to reject already-signed requests
- Verify JSON body limit is set to 25MB in \`server/index.ts\` (\`express.json({ limit: "25mb" })\`) to support large \`pdfBase64\` payloads from ArchiDoc

### 5. Transaction Safety (ACID)
- Verify envelope creation (POST \`/api/envelopes\`): envelope + signers + audit event wrapped in \`db.transaction()\`
- Verify ArchiDoc API (POST \`/api/v1/envelopes/create\`): envelope + signers + audit event wrapped in \`db.transaction()\`; if transaction fails after PDF file was saved from \`pdfBase64\`, the orphan file is deleted via \`fsPromises.unlink()\` in catch block
- Verify signing flow (POST \`/api/sign/:token/sign\`): atomicClaimSign + signature annotation + status update + audit event wrapped in \`db.transaction()\`
- Confirm \`atomicClaimSign()\` uses conditional UPDATE with \`WHERE signedAt IS NULL\` to prevent double-sign race conditions
- Verify PDF file generation (pdf-lib) happens AFTER transaction commit — no orphan files on rollback
- Confirm storage methods accept optional \`DbExecutor\` parameter for transaction participation

### 6. Gmail Integration
- Verify Gmail connector in \`server/gmail.ts\` uses Replit Google Mail connector (\`REPLIT_CONNECTORS_HOSTNAME\`) for OAuth token management
- Confirm token refresh: \`getAccessToken()\` checks \`expires_at\` and re-fetches from connector API when expired
- Verify \`sendEmail()\` supports plain HTML, threading (\`threadId\` parameter), and MIME attachments
- Confirm email-failure-safe send flow: if ALL emails fail on send, envelope stays in 'draft' status and returns 502 with failure details
- Verify partial failure handling: if some emails succeed and some fail, envelope is marked 'sent' with failure metadata in audit event
- Check that all 5 email templates use configurable settings loaded from DB via \`loadEmailSettings()\`: firmName, registrationLine, footerText, invitationBody, otpBody, completionBody, subjectPrefix
- Verify Gmail thread IDs are stored in \`envelopes.gmail_thread_id\` and reused for reply/query/completion emails

### 7. PDF Processing
- Verify pdf-lib is dynamically imported (\`await import("pdf-lib")\`) in both envelope creation (page count) and signing (annotation embedding)
- Confirm page count is extracted on upload and stored in \`envelopes.total_pages\`
- Verify ArchiDoc API \`pdfBase64\` handling: base64 string is decoded to Buffer, loaded via \`PDFDocument.load()\` for page count, saved to \`uploads/\` as \`api_\${timestamp}_\${random}.pdf\`; if the subsequent DB transaction fails, the saved file is cleaned up (deleted)
- Verify signed PDF generation embeds all signer annotations (initials + signatures) at correct x_pos/y_pos positions using \`StandardFonts.Helvetica\`
- Check that original PDFs are preserved — signed PDFs are saved as new files (\`signed_\${timestamp}.pdf\`)
- Verify the \`uploads/\` directory is created on startup via \`fsPromises.mkdir("uploads", { recursive: true })\`

### 8. Webhook Reliability
- Verify \`sendWebhook()\` uses \`AbortSignal.timeout(10000)\` for 10-second timeout
- Verify webhook is called on 3 events: \`envelope.sent\`, \`envelope.queried\` (includes queryFrom + queryMessage), \`envelope.signed\`
- Confirm webhook payloads include: event, envelopeId, externalRef, status
- Check that webhook failures are caught with try/catch and logged — never block or rollback the primary operation

### 9. Graceful Shutdown
- Verify \`server/index.ts\` registers handlers for both SIGTERM and SIGINT signals
- Confirm shutdown sequence: close HTTP server → close DB pool (\`pool.end()\`)
- Verify 10-second forced-exit timeout (\`setTimeout\` with \`.unref()\`) prevents hanging
- Confirm \`shuttingDown\` flag prevents duplicate shutdown attempts

### 10. Frontend Pages (11 pages)
- Verify all pages are registered in \`client/src/App.tsx\`:
  - Dashboard (\`/\`), New Envelope (\`/envelopes/new\`), Envelope Detail (\`/envelopes/:id\`)
  - Signer Verify (\`/sign/:token\`), Signer Document (\`/sign/:token/document\`)
  - Settings (\`/settings\`), Pre-Deployment (\`/pre-deployment\`)
  - Data Recovery (\`/data-recovery\`), Rollback Ledger (\`/rollback-ledger\`)
  - Login (\`/login\` — rendered at root for unauthenticated users via \`AuthenticatedAdmin\` component)
  - Not Found (fallback)
- Verify sidebar navigation links match registered routes
- Check that all interactive elements have \`data-testid\` attributes

### 11. Error Handling
- Verify all route handlers have try/catch with proper JSON error responses
- Check that database errors don't leak internal details to the client
- Confirm all file system operations use async \`fs/promises\` (no synchronous I/O)
- Verify multer error handling for invalid file types

### Output Format
For each check, report: PASS, WARN (with explanation), or FAIL (with remediation steps).
End with: **GO** (ready for deployment) or **NO-GO** (with blocking issues listed).`;

const DATA_PERSISTENCE_AUDIT_PROMPT = `## ARCHISIGN — DATA PERSISTENCE AUDIT (Pre-Deployment)

Run a full data persistence and integrity audit on the Archisign e-signature platform before deployment.

### 1. Entity Persistence Chains
Verify the complete lifecycle of each entity is persisted correctly:
- **Envelope chain**: Create (draft) → Send (sent) → View (viewed) → Query (queried) → Sign (signed)
  - Confirm each status transition calls \`updateEnvelope()\` which also sets \`updated_at\` to current timestamp
  - Verify \`signed_pdf_url\` is set when ALL signers have completed signing
  - Verify \`gmail_thread_id\` is captured on first email send and reused for all subsequent emails
  - Confirm reply to query resets status from 'queried' back to 'sent'
- **Signer chain**: Create (with crypto token) → OTP Request → OTP Verify → Initial Pages → Final Sign
  - Verify \`access_token\` is a 64-char hex string generated via \`crypto.randomBytes(32)\`
  - Confirm \`otp_code\` stores SHA-256 hash (not plaintext), \`otp_expires_at\` set 10 min in future
  - Verify after OTP verification: \`otp_verified = true\`, \`otp_code = NULL\`, \`otp_expires_at = NULL\`, \`last_viewed_at\` = current time
  - Verify \`signed_at\` is set atomically via \`atomicClaimSign()\` (conditional UPDATE WHERE signedAt IS NULL)
- **Annotation chain**: Initial per page → Final signature
  - Verify initials: type='initial', x_pos=0.9, y_pos=0.95, value = uppercase initials from full name
  - Verify signature: type='signature', x_pos=0.5, y_pos=0.9, value = full name, page_number = totalPages
  - Confirm position data (x_pos, y_pos) stored as normalized 0-1 real values

### 2. API Call Verification
Test each API endpoint persists data correctly:
- POST \`/api/envelopes\` → creates envelope + N signers + "Envelope created" audit event (ACID transaction), extracts PDF page count via pdf-lib
- POST \`/api/envelopes/:id/send\` → sends invitation emails to all signers, updates status to 'sent', creates "Envelope sent for signing" audit event, captures Gmail thread ID. If ALL emails fail: stays 'draft', returns 502, logs "Envelope send failed" audit event with failure details
- POST \`/api/envelopes/:id/reply\` → sends reply email to all signers, creates communication_log (isExternalQuery=false), resets status to 'sent', creates "Reply sent to signer query" audit event
- POST \`/api/sign/:token/request-otp\` → generates 6-digit OTP via \`crypto.randomInt()\`, stores SHA-256 hash + expiry on signer, sends OTP email, creates "OTP requested" audit event
- POST \`/api/sign/:token/verify-otp\` → compares hash of submitted code against stored hash, sets \`otp_verified=true\`, clears OTP fields, updates envelope status to 'viewed' if currently 'sent', creates "Identity verified via OTP" audit event
- POST \`/api/sign/:token/initial\` → creates annotation (type='initial') + "Page N initialed" audit event, returns updated list of initialed pages
- POST \`/api/sign/:token/query\` → creates communication_log (isExternalQuery=true), updates status to 'queried', forwards query to firm email, creates "Clarification requested" audit event, fires \`envelope.queried\` webhook
- POST \`/api/sign/:token/sign\` → within ACID transaction: atomicClaimSign + signature annotation + check if all signers signed + update status to 'signed' if yes + audit event. AFTER transaction: generates signed PDF with pdf-lib, sends completion emails, fires \`envelope.signed\` webhook
- POST \`/api/v1/envelopes/create\` → ArchiDoc API: requires \`X-API-KEY\` header validated against \`ARCHIDOC_API_KEY\` secret. Accepts \`pdfBase64\` (base64 PDF decoded to Buffer, saved to \`uploads/\`, page count extracted via pdf-lib) or \`pdfUrl\`. Supports \`signers\` array \`[{email, fullName}]\` for multi-signer envelopes, with backward-compatible \`signerEmail\`/\`signerName\`. Creates envelope + N signers + "Envelope created via API" audit event with metadata \`{source: "ArchiDoc", signerCount: N}\` (ACID transaction). Orphan file cleanup: if DB transaction fails after PDF save from \`pdfBase64\`, the file is deleted via \`fsPromises.unlink()\`
- POST \`/api/envelopes/:id/soft-delete\` → sets \`deleted_at\` to current timestamp (child records untouched)
- POST \`/api/envelopes/:id/restore\` → sets \`deleted_at\` to NULL (re-appears in active list)
- PUT \`/api/settings\` → bulk upsert array of {key, value, label, category} via \`onConflictDoUpdate\`
- POST \`/api/rollback-versions\` → creates version entry validated by \`insertRollbackVersionSchema\`
- POST \`/api/backups\` → exports envelopes + settings + rollbackVersions as JSON to \`backups/\` directory

### 3. Silent Data Loss Patterns
Check for scenarios where data could be silently lost:
- Verify \`ON DELETE CASCADE\` only triggers on hard-delete (which is NOT exposed via any API endpoint — only soft-delete is available)
- Verify soft-delete (setting \`deleted_at\`) does NOT cascade-delete child records (signers, annotations, logs, events remain intact for recovery)
- Check if partial signing state is preserved if a signer disconnects mid-process (initials are persisted individually, signing is atomic)
- Verify OTP expiry doesn't lock out signers permanently (POST \`/api/sign/:token/request-otp\` can be called again to generate a fresh OTP)
- Confirm email send failures keep envelope in 'draft' status (email-failure-safe send flow with 502 response)
- Check that webhook failures are caught and logged — never block, rollback, or alter the primary database operation
- Verify \`atomicClaimSign()\` prevents double-sign race conditions (concurrent requests get NULL result)

### 4. Database Record Counts
- Count total records across all 10 tables: envelopes (active WHERE deleted_at IS NULL + soft-deleted WHERE deleted_at IS NOT NULL), signers, annotations, communication_logs, audit_events, settings, rollback_versions, backups, users, sessions
- Verify no core tables are unexpectedly empty
- Check that audit_events exist for every envelope (minimum: "Envelope created" or "Envelope created via API")
- Note: audit_events may have null \`envelope_id\` for system-level auth events (e.g., "Unauthorized admin access attempt") — these are valid and expected
- Verify settings table has all 7 expected configuration keys: firm_name, email_registration_line, email_footer_text, email_invitation_body, email_otp_body, email_completion_body, email_invitation_subject_prefix

### 5. File Storage Persistence
- Verify uploaded PDFs exist at the paths stored in \`envelopes.original_pdf_url\` (format: \`/uploads/{multerFilename}.pdf\` or \`/uploads/api_{timestamp}_{random}.pdf\` for ArchiDoc \`pdfBase64\` uploads)
- Verify signed PDFs exist at the paths stored in \`envelopes.signed_pdf_url\` (format: \`/uploads/signed_{timestamp}.pdf\`) for fully-signed envelopes
- Check that the \`uploads/\` directory is created on startup and not emptied during deployment
- Verify JSON backup files exist in \`backups/\` directory at paths matching \`backups.filename\` records
- Confirm file paths use relative references that work in both dev and production

### 6. Backup & Recovery Readiness
- Verify database can be backed up via Replit's snapshot system
- Verify JSON backup creation via POST \`/api/backups\` exports: envelopes (with signers), settings, rollbackVersions
- Verify backup download via GET \`/api/backups/:id/download\` returns the correct JSON file
- Verify backup deletion via DELETE \`/api/backups/:id\` removes both the DB record and the filesystem file
- Check that \`uploads/\` and \`backups/\` directory contents would survive a redeployment
- Confirm no ephemeral/in-memory data stores are used for critical state — only \`loadEmailSettings()\` result is re-fetched per-request (not cached)
- Verify all application state is in PostgreSQL or filesystem (nothing in memory-only)

### 7. Settings Persistence
- Verify all 7 email template settings are stored in the \`settings\` table with category 'email'
- Confirm \`loadEmailSettings()\` in \`server/routes.ts\` fetches settings fresh from DB on every email send (no stale cache)
- Check that default fallback values exist in code for all 7 settings keys (firmName, registrationLine, footerText, invitationBody, otpBody, completionBody, subjectPrefix)
- Verify \`upsertSetting()\` uses \`onConflictDoUpdate\` on \`settings.key\` primary key for safe upserts

### 8. Rollback Version Ledger
- Verify \`rollback_versions\` table tracks deployment versions with: version_label (text NOT NULL), note (text nullable), status (active/superseded enum), created_at (timestamp)
- Confirm full CRUD: create (POST), read (GET), update status/note/label (PATCH), delete (DELETE)
- Verify PATCH only allows updates to: versionLabel, note, status (validated against "active"/"superseded")

### 9. Audit Trail Completeness
- Verify audit_events are created for every significant action:
  - "Envelope created" / "Envelope created via API"
  - "Envelope sent for signing" / "Envelope send failed - all emails failed"
  - "OTP requested" / "Identity verified via OTP"
  - "Page N initialed" / "Document signed"
  - "Clarification requested" / "Reply sent to signer query"
  - "Unauthorized admin access attempt" (system-level, with null \`envelopeId\`, records actor email, IP address, and path/method in metadata)
- Confirm each audit event records: envelopeId (nullable for system events), eventType, actorEmail, ipAddress, metadata, timestamp
- Verify audit events are ordered by timestamp DESC in API responses

### 10. Authentication Persistence
- Verify \`users\` table stores OIDC user profiles: id (UUID PK), email (unique), first_name, last_name, profile_image_url, created_at, updated_at
- Verify user profiles are upserted on each OIDC login (new users created, existing users updated)
- Verify \`sessions\` table stores session data: sid (PK), sess (jsonb), expire (timestamp NOT NULL)
- Verify sessions have a TTL and the \`expire\` column is indexed (\`IDX_session_expire\`) for efficient cleanup
- Verify session storage uses \`connect-pg-simple\` backed by the same PostgreSQL database
- Confirm expired sessions are cleaned up (either by \`connect-pg-simple\` pruning or via the index)

### Output Format
For each check, report: PASS, WARN (with explanation), or FAIL (with remediation steps).
End with: **GO** (ready for deployment) or **NO-GO** (with blocking issues listed).`;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast({ title: "Copied", description: `${label} copied to clipboard` });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Please try again", variant: "destructive" });
    }
  };

  return (
    <Button
      variant="outline"
      onClick={handleCopy}
      data-testid={`button-copy-${label.toLowerCase().replace(/\s/g, '-')}`}
    >
      {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
      {copied ? "Copied" : "Copy Prompt"}
    </Button>
  );
}

const REGEN_INSTRUCTION = `## ARCHISIGN — Update Pre-Deployment Audit Prompts

Analyse the current state of the Archisign application (database schema in shared/schema.ts, API routes in server/routes.ts, storage layer in server/storage.ts, Gmail integration in server/gmail.ts, frontend pages, and file storage in uploads/).

Regenerate all three pre-deployment audit prompts (Database Audit, Application Audit, Data Persistence Audit) to reflect the current state of the application. Update the prompts in client/src/pages/pre-deployment.tsx to match any new tables, columns, API endpoints, integrations, or workflows that have been added or modified since the prompts were last written.

Ensure each prompt is comprehensive and specific to Archisign's current architecture.`;

export default function PreDeployment() {
  const [regenCopied, setRegenCopied] = useState(false);
  const { toast } = useToast();

  const handleRegenCopy = async () => {
    try {
      await navigator.clipboard.writeText(REGEN_INSTRUCTION);
      setRegenCopied(true);
      toast({ title: "Copied", description: "Regeneration instruction copied to clipboard" });
      setTimeout(() => setRegenCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Please try again", variant: "destructive" });
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Link href="/settings" data-testid="link-back-settings">
            <Button variant="ghost" size="sm">
              <ChevronLeft className="h-4 w-4 mr-1" />
              Back to Settings
            </Button>
          </Link>
        </div>

        <div className="flex items-center gap-3">
          <div className="p-2 rounded-md bg-primary/10">
            <Shield className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Pre-Deployment Checks</h1>
            <p className="text-sm text-muted-foreground">Audits obligatoires avant chaque deployment</p>
          </div>
        </div>

        <Card className="border-2 border-destructive/50 bg-destructive/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
              <div className="space-y-2">
                <h3 className="font-semibold text-destructive" data-testid="text-critical-warning">Avertissement critique - Protection des donn&eacute;es</h3>
                <div className="text-sm space-y-1">
                  <p><strong>JAMAIS</strong> ex&eacute;cuter <code className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">npm run db:push --force</code> sur la production</p>
                  <p><strong>JAMAIS</strong> ex&eacute;cuter <code className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">drizzle-kit push --force</code> directement</p>
                  <p><strong>TOUJOURS</strong> cr&eacute;er un snapshot DB dans le panneau Replit avant d&eacute;ploiement</p>
                  <p className="text-destructive font-medium">Ces commandes <strong>PEUVENT SUPPRIMER DES DONN&Eacute;ES</strong> si le sch&eacute;ma a chang&eacute;</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800">
          <CardContent className="p-4">
            <p className="text-sm">
              <strong>Workflow:</strong> Copiez chaque prompt dans le chat Replit Agent avant d&eacute;ploiement. Les <strong>trois audits</strong> doivent passer (GO) avant de cliquer sur &quot;Publish&quot;.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <RefreshCw className="h-5 w-5 text-muted-foreground" />
                <div>
                  <h3 className="font-semibold text-sm">Mettre &agrave; jour les Prompts d&apos;Audit</h3>
                  <p className="text-xs text-muted-foreground">Demander &agrave; l&apos;Agent IA de r&eacute;g&eacute;n&eacute;rer les prompts selon l&apos;&eacute;tat actuel de l&apos;application</p>
                </div>
              </div>
              <Button
                variant="outline"
                onClick={handleRegenCopy}
                data-testid="button-copy-regen-instruction"
              >
                {regenCopied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                {regenCopied ? "Copied" : "Copy Instruction"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="p-1.5 rounded bg-primary/10">
                  <Database className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-bold" data-testid="text-audit-database">1. Database Audit</h3>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">V&eacute;rification base de donn&eacute;es &amp; migrations</p>
                </div>
              </div>
              <CopyButton text={DATABASE_AUDIT_PROMPT} label="Database Audit" />
            </div>
            <div className="bg-muted/50 rounded-md p-3">
              <p className="text-sm text-muted-foreground font-mono">
                V&eacute;rifie: Schema sync, Destructive changes, Secrets, Orphaned records, Indexes, ID column safety...
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="p-1.5 rounded bg-green-500/10">
                  <Shield className="h-5 w-5 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <h3 className="font-bold" data-testid="text-audit-application">2. Application Audit</h3>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">V&eacute;rification code, s&eacute;curit&eacute; &amp; build</p>
                </div>
              </div>
              <CopyButton text={APPLICATION_AUDIT_PROMPT} label="Application Audit" />
            </div>
            <div className="bg-muted/50 rounded-md p-3">
              <p className="text-sm text-muted-foreground font-mono">
                V&eacute;rifie: Secrets, Build, Hardcoded credentials, Error handling, AI integration, Entry point...
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="p-1.5 rounded bg-orange-500/10">
                  <Link2 className="h-5 w-5 text-orange-600 dark:text-orange-400" />
                </div>
                <div>
                  <h3 className="font-bold" data-testid="text-audit-persistence">3. Data Persistence Audit</h3>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">V&eacute;rification sauvegarde des donn&eacute;es</p>
                </div>
              </div>
              <CopyButton text={DATA_PERSISTENCE_AUDIT_PROMPT} label="Data Persistence Audit" />
            </div>
            <div className="bg-muted/50 rounded-md p-3">
              <p className="text-sm text-muted-foreground font-mono">
                V&eacute;rifie: Entity persistence chains, API call verification, Silent data loss patterns, Database record counts, Backup readiness, Soft-delete chain, Recovery simulation...
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800">
          <CardContent className="p-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
              <div className="space-y-2">
                <h3 className="font-semibold" data-testid="text-deployment-criteria">Crit&egrave;res de d&eacute;ploiement</h3>
                <ul className="text-sm space-y-1.5">
                  <li>Les <strong>trois audits</strong> doivent afficher &quot;GO&quot; ou &quot;READY FOR DEPLOYMENT&quot;</li>
                  <li>Aucun <strong>CRITICAL BLOCKER</strong> ou <strong>SILENT DATA LOSS</strong> ne doit &ecirc;tre pr&eacute;sent</li>
                  <li><strong>DATA PROTECTION</strong>: Backup r&eacute;cent (&lt;24h), soft-delete fonctionnel, endpoints recovery OK</li>
                  <li>Les <strong>WARN</strong> sont acceptables mais doivent &ecirc;tre document&eacute;s</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
