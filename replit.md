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
  components/app-sidebar.tsx - Navigation sidebar
  components/theme-toggle.tsx - Dark/light mode
  lib/theme-provider.tsx     - Theme context

server/
  routes.ts    - All API endpoints
  storage.ts   - Database storage layer
  db.ts        - Drizzle/PostgreSQL connection
  gmail.ts     - Gmail API integration
  seed.ts      - Sample data seeder

shared/
  schema.ts    - Drizzle models + Zod schemas
```

## Key Features (continued)
7. **Settings Page** - Admin-editable email copy text (firm name, registration line, footer, invitation/OTP/completion email bodies) stored in DB and used by all outbound email templates

## Recent Changes
- 2026-02-13: Added Rollback Ledger page (version tracking with ACTIVE/SUPERSEDED statuses, CRUD operations)
- 2026-02-13: Added Data Recovery page (soft-deleted envelopes recovery, JSON backup creation/download/delete)
- 2026-02-13: Added Pre-Deployment Checks page with three audit prompt cards
- 2026-02-13: Added Settings page with editable email copy text, stored in DB settings table
- 2026-02-13: Added inline PDF viewing in envelope detail and signer document pages
- 2026-02-13: Initial MVP build with full schema, admin UI, signing flow, Gmail integration
