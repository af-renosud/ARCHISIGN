import { Router } from "express";
import { storage } from "../storage";
import { ContactService, ContactConflictError, ContactNotFoundError, ContactSourceMismatchError } from "../services/ContactService";
import { localContactCreateSchema, localContactUpdateSchema } from "@shared/schema";
import { asyncHandler } from "../middleware/asyncHandler";
import { validateId } from "../middleware/validators";

export function buildContactsRouter(): Router {
  const router = Router();

  router.get("/", asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const sourceParam = typeof req.query.source === "string" ? req.query.source : undefined;
    const includeArchived = req.query.includeArchived === "1" || req.query.includeArchived === "true";
    const source = sourceParam === "archidoc" || sourceParam === "local" ? sourceParam : undefined;
    const limit = Math.min(Number.parseInt(String(req.query.limit ?? "200"), 10) || 200, 500);
    const rows = await storage.searchContacts({ q, source, includeArchived, limit });
    res.json(rows);
  }));

  router.post("/", asyncHandler(async (req, res) => {
    const parsed = localContactCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid contact", errors: parsed.error.flatten().fieldErrors });
    }
    try {
      const contact = await ContactService.createLocal(parsed.data);
      res.status(201).json(contact);
    } catch (err) {
      if (err instanceof ContactConflictError) return res.status(409).json({ message: err.message });
      throw err;
    }
  }));

  router.patch("/:id", validateId, asyncHandler(async (req, res) => {
    const id = (req as any).validatedId as number;
    const parsed = localContactUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid contact", errors: parsed.error.flatten().fieldErrors });
    }
    try {
      const contact = await ContactService.updateLocal(id, parsed.data);
      res.json(contact);
    } catch (err) {
      if (err instanceof ContactNotFoundError) return res.status(404).json({ message: err.message });
      if (err instanceof ContactSourceMismatchError) return res.status(403).json({ message: err.message });
      throw err;
    }
  }));

  router.delete("/:id", validateId, asyncHandler(async (req, res) => {
    const id = (req as any).validatedId as number;
    try {
      const contact = await ContactService.archiveLocal(id);
      res.json(contact);
    } catch (err) {
      if (err instanceof ContactNotFoundError) return res.status(404).json({ message: err.message });
      if (err instanceof ContactSourceMismatchError) return res.status(403).json({ message: err.message });
      throw err;
    }
  }));

  return router;
}
