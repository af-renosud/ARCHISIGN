import type { Request, Response, RequestHandler } from "express";
import { storage as defaultStorage } from "../storage";
import { continueEnvelopeRequestSchema } from "@shared/schema";
import {
  createContinuationEnvelope as defaultCreateContinuationEnvelope,
  ContinuationError,
} from "../services/ContinuationService";
import { asyncHandler } from "../middleware/asyncHandler";

/**
 * "Send for further signature" routes, in the injectable-handler style of
 * resend.ts so they can be mounted on a throwaway Express app under the Node
 * test harness. All eligibility/PDF/transaction logic lives in
 * ContinuationService; these handlers only validate input and map errors.
 */
export interface ContinuationHandlerDeps {
  storage: Pick<typeof defaultStorage, "getEnvelope" | "getEnvelopeContinuations">;
  createContinuationEnvelope: typeof defaultCreateContinuationEnvelope;
  bumpContactsLastUsed: (emails: string[]) => Promise<void>;
}

export function buildContinueHandler(
  overrides: Partial<ContinuationHandlerDeps> = {},
): RequestHandler {
  const storage = overrides.storage ?? defaultStorage;
  const createContinuation =
    overrides.createContinuationEnvelope ?? defaultCreateContinuationEnvelope;
  const bumpContactsLastUsed = overrides.bumpContactsLastUsed ?? (async () => {});

  return asyncHandler(async (req: Request<any>, res: Response) => {
    const id = (req as any).validatedId ?? parseInt(req.params.id);
    const parsed = continueEnvelopeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid continuation data", errors: parsed.error.flatten().fieldErrors });
    }
    try {
      const child = await createContinuation({
        parentEnvelopeId: id,
        signers: parsed.data.signers,
        subject: parsed.data.subject,
        message: parsed.data.message ?? null,
        actorEmail: (req.user as any)?.claims?.email ?? null,
        ipAddress: req.ip || null,
      });
      bumpContactsLastUsed(parsed.data.signers.map((s) => s.email)).catch(() => {});
      const full = await storage.getEnvelope(child.id);
      return res.status(201).json(full ?? child);
    } catch (err) {
      if (err instanceof ContinuationError) {
        return res.status(err.httpStatus).json({ code: err.code, message: err.message });
      }
      throw err;
    }
  });
}

export function buildLineageHandler(
  overrides: Partial<ContinuationHandlerDeps> = {},
): RequestHandler {
  const storage = overrides.storage ?? defaultStorage;

  return asyncHandler(async (req: Request<any>, res: Response) => {
    const id = (req as any).validatedId ?? parseInt(req.params.id);
    const envelope = await storage.getEnvelope(id);
    if (!envelope) return res.status(404).json({ message: "Envelope not found" });
    const summarize = (e: { id: number; subject: string; status: string; createdAt: Date }) => ({
      id: e.id, subject: e.subject, status: e.status, createdAt: e.createdAt,
    });
    const [parent, children] = await Promise.all([
      envelope.parentEnvelopeId
        ? storage.getEnvelope(envelope.parentEnvelopeId)
        : Promise.resolve(undefined),
      storage.getEnvelopeContinuations(id),
    ]);
    res.json({
      parent: parent && !parent.deletedAt ? summarize(parent) : null,
      continuations: children.map(summarize),
    });
  });
}
