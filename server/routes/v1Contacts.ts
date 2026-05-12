import { Router } from "express";
import { storage } from "../storage";
import { ContactService, ContactSourceMismatchError } from "../services/ContactService";
import { archidocContactUpsertSchema } from "@shared/schema";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler";
import { apiKeyAuth } from "../middleware/apiKeyAuth";
import { rateLimit } from "../middleware/rateLimit";

function ensureArchidocTenant(req: any, res: any): boolean {
  if (req.apiKeyAuth?.tenant !== "archidoc") {
    res.status(403).json({ error: "tenant_forbidden", message: "Contacts channel is restricted to the archidoc tenant" });
    return false;
  }
  return true;
}

async function audit(eventType: string, actor: string, ip: string | null, metadata: unknown) {
  try {
    await storage.createAuditEvent({
      envelopeId: null,
      eventType,
      actorEmail: actor,
      ipAddress: ip,
      metadata: JSON.stringify(metadata),
    });
  } catch {
    // best-effort
  }
}

export function buildV1ContactsRouter(): Router {
  const router = Router();
  router.use(apiKeyAuth);
  router.use((err: any, _req: any, res: any, next: any) => {
    if (err && (err.type === "entity.too.large" || err.status === 413)) {
      return res.status(413).json({ error: "payload_too_large", message: "Body exceeds 5 MiB", limit: { kind: "byte_size", ceiling: 5 * 1024 * 1024 } });
    }
    return next(err);
  });

  /**
   * PUT /api/v1/contacts/archidoc/:id — upsert a single archidoc contact.
   * Stale (older sourceUpdatedAt) → 200 {applied:false, reason:"stale"}.
   * v1.3.1: body.id, when present, must equal :id (else 400 id_mismatch).
   *         email may be null (system actors / contractors without email).
   */
  router.put("/contacts/archidoc/:id", rateLimit("contacts"), asyncHandler(async (req, res) => {
    if (!ensureArchidocTenant(req, res)) return;
    const archidocUserId = req.params.id;
    if (!archidocUserId || archidocUserId.length === 0) {
      return res.status(400).json({ error: "invalid_request", message: "archidoc id required" });
    }
    const parsed = archidocContactUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", fieldErrors: parsed.error.flatten().fieldErrors });
    }
    if (parsed.data.id && parsed.data.id !== archidocUserId) {
      return res.status(400).json({ error: "id_mismatch", message: "body.id must equal URL :id when both are present" });
    }
    try {
      const result = await ContactService.upsertArchidoc({
        archidocUserId,
        email: parsed.data.email ?? null,
        displayName: parsed.data.displayName,
        organization: parsed.data.organization ?? null,
        category: parsed.data.category,
        role: parsed.data.role ?? null,
        phone: parsed.data.phone ?? null,
        sourceUpdatedAt: parsed.data.sourceUpdatedAt,
      });
      await audit("contact.synced", req.apiKeyAuth!.tenant, req.ip || null, {
        archidocUserId,
        applied: result.applied,
        reason: result.reason ?? null,
        contactId: result.contact.id,
      });
      if (!result.applied) {
        return res.status(200).json({ applied: false, reason: result.reason });
      }
      res.status(200).json({ applied: true, contact: result.contact });
    } catch (err) {
      if (err instanceof ContactSourceMismatchError) return res.status(409).json({ error: "source_mismatch", message: err.message });
      throw err;
    }
  }));

  /**
   * DELETE /api/v1/contacts/archidoc/:id — archive an archidoc contact.
   * Unknown id → 200 {archived:true, alreadyArchived:true} (idempotent).
   */
  router.delete("/contacts/archidoc/:id", rateLimit("contacts"), asyncHandler(async (req, res) => {
    if (!ensureArchidocTenant(req, res)) return;
    const archidocUserId = req.params.id;
    if (!archidocUserId) {
      return res.status(400).json({ error: "invalid_request", message: "archidoc id required" });
    }
    try {
      const result = await ContactService.archiveArchidoc(archidocUserId);
      await audit("contact.archived", req.apiKeyAuth!.tenant, req.ip || null, {
        archidocUserId,
        alreadyArchived: result.alreadyArchived,
      });
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof ContactSourceMismatchError) return res.status(409).json({ error: "source_mismatch", message: err.message });
      throw err;
    }
  }));

  /**
   * POST /api/v1/contacts/archidoc/bulk — partial-success batch upsert.
   * v1.3.1:
   *   - Body accepts EITHER `contacts` OR `rows` (ArchiDoc emits `rows`).
   *   - Optional `batchId` (body) or `X-Batch-Id` (header) → server-side dedup
   *     keyed on `(tenant, batchId, archidocUserId)` so re-runs of the same chunk
   *     return the prior outcome without re-applying.
   *   - Per-row partial success preserved; whole-batch never rejected on one bad row.
   *   - Hard caps: ≤500 rows (413 row_count) and ≤5 MiB body (413 byte_size).
   */
  const bulkRowSchema = z.object({
    id: z.string().min(1),
    email: z.string().email().nullish(),
    displayName: z.string().min(1),
    organization: z.string().nullish(),
    category: z.enum(["client", "contractor", "partner", "internal", "other"]),
    role: z.string().nullish(),
    phone: z.string().nullish(),
    sourceUpdatedAt: z.string().datetime({ offset: true }),
  });
  router.post("/contacts/archidoc/bulk", rateLimit("contacts"), asyncHandler(async (req, res) => {
    if (!ensureArchidocTenant(req, res)) return;
    const body = req.body || {};
    // v1.3.1: accept rows (ArchiDoc) or contacts (frozen v1.3 contract).
    const rawRows = Array.isArray(body.rows) ? body.rows : (Array.isArray(body.contacts) ? body.contacts : null);
    if (!rawRows) {
      return res.status(400).json({ error: "invalid_request", message: "rows[] (or contacts[]) required" });
    }
    if (rawRows.length > 500) {
      return res.status(413).json({ error: "payload_too_large", message: "Bulk size exceeds 500", limit: { kind: "row_count", ceiling: 500 } });
    }
    if (rawRows.length === 0) {
      return res.status(400).json({ error: "invalid_request", message: "rows[] must not be empty" });
    }
    const headerBatchId = (req.headers["x-batch-id"] as string | undefined)?.trim() || undefined;
    const bodyBatchId = typeof body.batchId === "string" && body.batchId.trim().length > 0 ? body.batchId.trim() : undefined;
    if (headerBatchId && bodyBatchId && headerBatchId !== bodyBatchId) {
      return res.status(400).json({ error: "batch_id_mismatch", message: "X-Batch-Id header and body.batchId disagree" });
    }
    const batchId = bodyBatchId || headerBatchId;
    const tenant = req.apiKeyAuth!.tenant;

    const accepted: Array<{ id: string; applied: boolean; reason?: string; contactId?: number; deduplicated?: true }> = [];
    const rejected: Array<{ id: string; error: string; deduplicated?: true }> = [];

    for (let idx = 0; idx < rawRows.length; idx++) {
      const raw = rawRows[idx];
      const fallbackId = typeof raw?.id === "string" && raw.id.length > 0 ? raw.id : `index-${idx}`;

      // Dedup check before any work, when batchId provided.
      if (batchId && typeof raw?.id === "string" && raw.id.length > 0) {
        const prior = await storage.getBulkDedupRow(tenant, batchId, raw.id);
        if (prior) {
          if (prior.outcome === "rejected") {
            rejected.push({ id: raw.id, error: prior.errorMessage || "previously_rejected", deduplicated: true });
          } else {
            const entry: any = { id: raw.id, applied: prior.outcome === "applied", deduplicated: true };
            if (prior.reason) entry.reason = prior.reason;
            if (prior.contactId !== null && prior.contactId !== undefined) entry.contactId = prior.contactId;
            accepted.push(entry);
          }
          continue;
        }
      }

      const parsed = bulkRowSchema.safeParse(raw);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        const errMsg = firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "invalid_row";
        rejected.push({ id: fallbackId, error: errMsg });
        if (batchId && typeof raw?.id === "string" && raw.id.length > 0) {
          await storage.recordBulkDedupRow({
            tenant, batchId, archidocUserId: raw.id,
            outcome: "rejected", reason: null, contactId: null, errorMessage: errMsg,
          });
        }
        continue;
      }
      const row = parsed.data;
      try {
        const result = await ContactService.upsertArchidoc({
          archidocUserId: row.id,
          email: row.email ?? null,
          displayName: row.displayName,
          organization: row.organization ?? null,
          category: row.category,
          role: row.role ?? null,
          phone: row.phone ?? null,
          sourceUpdatedAt: row.sourceUpdatedAt,
        });
        accepted.push({
          id: row.id,
          applied: result.applied,
          ...(result.reason ? { reason: result.reason } : {}),
          contactId: result.contact.id,
        });
        if (batchId) {
          await storage.recordBulkDedupRow({
            tenant, batchId, archidocUserId: row.id,
            outcome: result.applied ? "applied" : (result.reason || "skipped"),
            reason: result.reason ?? null,
            contactId: result.contact.id,
            errorMessage: null,
          });
        }
      } catch (err: any) {
        const errMsg = err?.message || "upsert_failed";
        rejected.push({ id: row.id, error: errMsg });
        if (batchId) {
          await storage.recordBulkDedupRow({
            tenant, batchId, archidocUserId: row.id,
            outcome: "rejected", reason: null, contactId: null, errorMessage: errMsg,
          });
        }
      }
    }
    // v1.3.2: split deduplicated rows out of acceptedCount so post-mortems read
    // cleanly without cross-referencing ArchiDoc telemetry. Additive metadata —
    // existing v1.3.1 consumers ignore unknown fields.
    //
    // Invariant: appliedCount = acceptedCount - deduplicatedCount.
    // deduplicatedCount intentionally counts only accepted-side dedup hits so the
    // arithmetic holds; rejected-side dedup hits are reported separately as
    // rejectedDeduplicatedCount for full visibility.
    const deduplicatedCount = accepted.filter(a => a.deduplicated).length;
    const rejectedDeduplicatedCount = rejected.filter(r => r.deduplicated).length;
    const appliedCount = accepted.length - deduplicatedCount;
    await audit("contact.bulk_imported", tenant, req.ip || null, {
      total: rawRows.length,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      deduplicatedCount,
      rejectedDeduplicatedCount,
      appliedCount,
      batchId: batchId ?? null,
    });
    res.status(200).json({ accepted, rejected, ...(batchId ? { batchId } : {}) });
  }));

  return router;
}
