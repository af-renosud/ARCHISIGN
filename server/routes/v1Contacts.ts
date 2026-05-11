import { Router } from "express";
import { storage } from "../storage";
import { ContactService, ContactSourceMismatchError } from "../services/ContactService";
import { archidocContactUpsertSchema, archidocContactBulkSchema } from "@shared/schema";
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

  /**
   * PUT /api/v1/contacts/archidoc/:id — upsert a single archidoc contact.
   * Stale (older sourceUpdatedAt) → 200 {applied:false, reason:"stale"}.
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
    try {
      const result = await ContactService.upsertArchidoc({ ...parsed.data, archidocUserId });
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
   * Max 500 rows; per-row outcome reported.
   */
  router.post("/contacts/archidoc/bulk", rateLimit("contacts"), asyncHandler(async (req, res) => {
    if (!ensureArchidocTenant(req, res)) return;
    const parsed = archidocContactBulkSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", fieldErrors: parsed.error.flatten().fieldErrors });
    }
    const accepted: Array<{ id: string; applied: boolean; reason?: string; contactId: number }> = [];
    const rejected: Array<{ id: string; error: string }> = [];
    for (const row of parsed.data.contacts) {
      try {
        const result = await ContactService.upsertArchidoc({
          archidocUserId: row.id,
          email: row.email,
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
      } catch (err: any) {
        rejected.push({ id: row.id, error: err?.message || "upsert_failed" });
      }
    }
    await audit("contact.bulk_imported", req.apiKeyAuth!.tenant, req.ip || null, {
      total: parsed.data.contacts.length,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
    });
    res.status(200).json({ accepted, rejected });
  }));

  return router;
}
