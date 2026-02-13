# ArchiSign Pro - E-Signature Platform

## Overview
ArchiSign Pro is a specialized internal tool for a French architecture firm to handle external sign-offs (clients, contractors, partners) for architectural plans and contracts. It integrates with Gmail for email communication and provides a secure, tokenized signing workflow.

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
- `envelopes` - Documents sent for signing
- `signers` - External parties who sign
- `annotations` - Initials/signatures per page
- `communication_logs` - Query messages between parties
- `audit_events` - Full audit trail

## Project Structure
```
client/src/
  pages/dashboard.tsx        - Admin dashboard
  pages/envelope-new.tsx     - Create envelope form
  pages/envelope-detail.tsx  - Envelope detail + tabs (overview, signers, communication, audit)
  pages/signer-verify.tsx    - External OTP verification
  pages/signer-document.tsx  - Document signing interface
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

## Recent Changes
- 2026-02-13: Initial MVP build with full schema, admin UI, signing flow, Gmail integration
