import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Database, Shield, Link2, Copy, Check, ChevronLeft, CheckCircle2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";

const DATABASE_AUDIT_PROMPT = `## ARCHISIGN — DATABASE AUDIT (Pre-Deployment)

Run a full database audit on the Archisign e-signature platform before deployment.

### 1. Schema Sync Verification
- Compare the Drizzle ORM schema in \`shared/schema.ts\` against the live PostgreSQL database
- Verify all tables exist: \`envelopes\`, \`signers\`, \`annotations\`, \`communication_logs\`, \`audit_events\`, \`settings\`
- Verify all enum types exist: \`envelope_status\` (draft, sent, viewed, queried, signed, declined), \`annotation_type\` (initial, signature, date)
- Confirm all columns match their Drizzle definitions (types, defaults, nullability)
- Check that \`generatedAlwaysAsIdentity()\` is correctly applied on all ID columns

### 2. Foreign Key & Cascade Verification
- Verify FK constraints: \`signers.envelope_id → envelopes.id\`, \`annotations.envelope_id → envelopes.id\`, \`annotations.signer_id → signers.id\`, \`communication_logs.envelope_id → envelopes.id\`, \`audit_events.envelope_id → envelopes.id\`
- Confirm all FKs have \`ON DELETE CASCADE\`
- Test: deleting an envelope should cascade-delete its signers, annotations, logs, and audit events

### 3. Unique Constraints & Indexes
- Verify \`signers.access_token\` has a UNIQUE constraint
- Verify \`settings.key\` is the primary key
- Check for any missing indexes on frequently queried columns (e.g., \`signers.envelope_id\`, \`annotations.envelope_id\`)

### 4. Orphaned Records Check
- Query for signers with no matching envelope
- Query for annotations with no matching signer or envelope
- Query for communication_logs with no matching envelope
- Query for audit_events with no matching envelope
- Report any orphaned data

### 5. Destructive Changes Detection
- Check if \`npm run db:push\` would produce any destructive ALTER TABLE statements
- NEVER run \`db:push --force\` on production without explicit approval
- Flag any column type changes, dropped columns, or renamed tables

### 6. Secrets & Connection Safety
- Verify DATABASE_URL is set and accessible
- Verify connection pool is healthy (no stale connections)
- Confirm no database credentials are hardcoded in source files

### Output Format
For each check, report: ✅ PASS, ⚠️ WARN (with explanation), or ❌ FAIL (with remediation steps).
End with: **GO** (ready for deployment) or **NO-GO** (with blocking issues listed).`;

const APPLICATION_AUDIT_PROMPT = `## ARCHISIGN — APPLICATION AUDIT (Pre-Deployment)

Run a full application code and security audit on the Archisign e-signature platform before deployment.

### 1. Build Verification
- Run \`npm run build\` and confirm it completes without errors
- Check TypeScript compilation (\`npm run check\`) for type errors
- Verify the production entry point \`dist/index.cjs\` is generated correctly
- Confirm Vite frontend build produces valid output in \`dist/public/\`

### 2. API Route Integrity
- Verify all API routes in \`server/routes.ts\` are reachable:
  - Admin: GET/POST \`/api/envelopes\`, GET \`/api/envelopes/:id\`, POST \`/api/envelopes/:id/send\`, POST \`/api/envelopes/:id/reply\`
  - Signer: GET \`/api/sign/:token/info\`, POST \`/api/sign/:token/request-otp\`, POST \`/api/sign/:token/verify-otp\`, GET \`/api/sign/:token/document\`, POST \`/api/sign/:token/initial\`, POST \`/api/sign/:token/query\`, POST \`/api/sign/:token/sign\`
  - ArchiDoc API: POST \`/api/v1/envelopes/create\`
  - Settings: GET/PUT \`/api/settings\`, GET \`/api/settings/:key\`
  - Static: GET \`/uploads/*\`
- Verify proper error handling (400, 404, 500 responses) on each route
- Check that all routes validate input before database operations

### 3. Security Checks
- Confirm no secrets (DATABASE_URL, SESSION_SECRET, API keys) are hardcoded in source code
- Verify signing tokens are generated with \`crypto.randomBytes(32)\` (cryptographically secure)
- Verify OTP codes expire after 10 minutes and are cleared after verification
- Check that signer document endpoints require OTP verification (\`otpVerified === true\`)
- Confirm no sensitive data (OTP codes, access tokens) is exposed in API responses
- Verify file upload only accepts PDF MIME type with 50MB limit

### 4. Gmail Integration
- Verify Gmail connector in \`server/gmail.ts\` handles token refresh correctly
- Confirm email sending gracefully handles failures (try/catch, no crash on send failure)
- Check that email templates use configurable settings from the database (not hardcoded copy)
- Verify Gmail thread IDs are preserved for conversation continuity

### 5. PDF Processing
- Verify pdf-lib import is dynamic (\`await import("pdf-lib")\`) for proper code splitting
- Confirm signed PDF generation embeds all annotations at correct positions
- Check that original PDFs are preserved (not overwritten during signing)
- Verify the \`uploads/\` directory is created on startup

### 6. Webhook Reliability
- Verify webhook calls are fire-and-forget (don't block the response)
- Confirm webhook payloads include \`event\`, \`envelopeId\`, \`externalRef\`, \`status\`
- Check that webhook failures are caught and logged (not thrown)

### 7. Error Handling
- Verify all route handlers have try/catch with proper error responses
- Check that database errors don't leak internal details to the client
- Confirm file system operations handle missing files gracefully

### Output Format
For each check, report: ✅ PASS, ⚠️ WARN (with explanation), or ❌ FAIL (with remediation steps).
End with: **GO** (ready for deployment) or **NO-GO** (with blocking issues listed).`;

const DATA_PERSISTENCE_AUDIT_PROMPT = `## ARCHISIGN — DATA PERSISTENCE AUDIT (Pre-Deployment)

Run a full data persistence and integrity audit on the Archisign e-signature platform before deployment.

### 1. Entity Persistence Chains
Verify the complete lifecycle of each entity is persisted correctly:
- **Envelope chain**: Create (draft) → Send (sent) → View (viewed) → Query (queried) → Sign (signed)
  - Confirm status transitions update \`updated_at\` timestamp
  - Verify \`signed_pdf_url\` is set when all signers complete
- **Signer chain**: Create → OTP Request → OTP Verify → Initial Pages → Final Sign
  - Confirm \`otp_verified\` is set to true after verification
  - Verify \`signed_at\` is set after final signature
  - Check \`last_viewed_at\` is updated on document access
- **Annotation chain**: Initial per page → Final signature
  - Verify position data (x_pos, y_pos) is stored as normalized 0-1 values
  - Confirm annotation type and value are correct

### 2. API Call Verification
Test each API endpoint persists data correctly:
- POST \`/api/envelopes\` → creates envelope + signers + audit event
- POST \`/api/envelopes/:id/send\` → updates status + creates audit event + sets Gmail thread ID
- POST \`/api/sign/:token/request-otp\` → sets otp_code + otp_expires_at on signer
- POST \`/api/sign/:token/verify-otp\` → sets otp_verified + clears OTP fields + creates audit event
- POST \`/api/sign/:token/initial\` → creates annotation record + audit event
- POST \`/api/sign/:token/sign\` → creates signature annotation + updates signer.signed_at + generates signed PDF if all signed
- POST \`/api/sign/:token/query\` → creates communication_log + audit event + updates status to queried
- POST \`/api/v1/envelopes/create\` → creates envelope + signer + audit event (ArchiDoc API)

### 3. Silent Data Loss Patterns
Check for scenarios where data could be silently lost:
- Verify \`ON DELETE CASCADE\` doesn't accidentally delete data when envelopes are removed
- Check if partial signing state is preserved if a signer disconnects mid-process
- Verify OTP expiry doesn't lock out signers permanently (they can request a new OTP)
- Confirm email send failures don't prevent envelope status updates
- Check that webhook failures don't block or rollback signing operations

### 4. Database Record Counts
- Count total envelopes, signers, annotations, communication_logs, audit_events, settings
- Verify no tables are unexpectedly empty
- Check that audit_events exist for every envelope (at minimum: "Envelope created")
- Verify settings table has all expected configuration keys

### 5. File Storage Persistence
- Verify uploaded PDFs exist at the paths stored in \`envelopes.original_pdf_url\`
- Verify signed PDFs exist at the paths stored in \`envelopes.signed_pdf_url\` (where applicable)
- Check that the \`uploads/\` directory is not emptied during deployment
- Confirm file paths use relative references that work in both dev and production

### 6. Backup & Recovery Readiness
- Verify database can be backed up via Replit's snapshot system
- Check that \`uploads/\` directory content would survive a redeployment
- Confirm no ephemeral/in-memory data stores are used for critical state
- Verify all application state is in PostgreSQL or filesystem (nothing in memory-only)

### 7. Settings Persistence
- Verify all email template settings are stored in the \`settings\` table
- Confirm settings survive server restarts (not cached in memory only)
- Check that default fallback values exist in code for all settings keys

### Output Format
For each check, report: ✅ PASS, ⚠️ WARN (with explanation), or ❌ FAIL (with remediation steps).
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
