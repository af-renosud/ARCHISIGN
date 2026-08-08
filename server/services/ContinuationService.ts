import { storage as defaultStorage } from "../storage";
import { db } from "../db";
import { downloadFile as defaultDownloadFile, uploadFile as defaultUploadFile, deleteFile as defaultDeleteFile } from "../fileStorage";
import { createHash } from "crypto";
import { stripCertificatePages as defaultStripCertificatePages } from "./PdfService";
import { generateToken as defaultGenerateToken } from "./SecurityService";
import type { Envelope } from "@shared/schema";

/**
 * ContinuationService — "send a signed document on for further signature".
 *
 * A signed envelope is immutable evidence: its audit trail, certificate,
 * integrity hash and webhook history are never reopened. Instead this service
 * creates a NEW draft envelope (a "continuation") whose working document is a
 * copy of the parent's signed PDF (certificate pages stripped so no fields can
 * land on them), linked back to the parent via parentEnvelopeId and pinned to
 * the parent's documentHash at continuation time.
 *
 * Partner-origin envelopes (created via /api/v1 by ArchiDoc/ArchiTrak) are
 * rejected: the inter-app contract treats the first envelope.signed event as
 * terminal and maps one envelope ID per document, so enabling continuations
 * for those tenants requires a contract amendment first (tracked separately).
 */

export interface ContinuationSignerInput {
  email: string;
  fullName: string;
}

export interface CreateContinuationInput {
  parentEnvelopeId: number;
  signers: ContinuationSignerInput[];
  /** Optional subject override; defaults to "<parent subject> — further signature". */
  subject?: string;
  /** Optional message shown in the invitation email. */
  message?: string | null;
  actorEmail?: string | null;
  ipAddress?: string | null;
}

export class ContinuationError extends Error {
  constructor(
    public readonly code:
      | "parent_not_found"
      | "parent_not_signed"
      | "parent_api_origin"
      | "parent_pdf_unavailable",
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
  }
}

export interface ContinuationDeps {
  storage: Pick<
    typeof defaultStorage,
    "getEnvelope" | "createEnvelope" | "createSigner" | "createAuditEvent"
  >;
  downloadFile: typeof defaultDownloadFile;
  uploadFile: typeof defaultUploadFile;
  deleteFile: typeof defaultDeleteFile;
  stripCertificatePages: typeof defaultStripCertificatePages;
  generateToken: typeof defaultGenerateToken;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
}

const defaultDeps: ContinuationDeps = {
  storage: defaultStorage,
  downloadFile: defaultDownloadFile,
  uploadFile: defaultUploadFile,
  deleteFile: defaultDeleteFile,
  stripCertificatePages: defaultStripCertificatePages,
  generateToken: defaultGenerateToken,
  transaction: (fn) => db.transaction(fn),
};

/**
 * Validate eligibility and create the continuation draft transactionally.
 * Returns the newly created child envelope. Never mutates the parent beyond
 * appending an audit event.
 */
export async function createContinuationEnvelope(
  input: CreateContinuationInput,
  overrides: Partial<ContinuationDeps> = {},
): Promise<Envelope> {
  const deps: ContinuationDeps = { ...defaultDeps, ...overrides };
  const { storage } = deps;

  const parent = await storage.getEnvelope(input.parentEnvelopeId);
  if (!parent || parent.deletedAt) {
    throw new ContinuationError("parent_not_found", "Envelope not found", 404);
  }
  if (parent.status !== "signed") {
    throw new ContinuationError(
      "parent_not_signed",
      `Only fully signed envelopes can be sent for further signature (status is "${parent.status}").`,
      409,
    );
  }
  if (parent.origin) {
    throw new ContinuationError(
      "parent_api_origin",
      "This envelope was created by a partner application via the API. Continuations of partner-created envelopes are not yet supported by the inter-app contract.",
      409,
    );
  }
  if (!parent.signedPdfUrl) {
    throw new ContinuationError(
      "parent_pdf_unavailable",
      "The signed PDF for this envelope is unavailable, so it cannot be sent for further signature.",
      409,
    );
  }

  // Copy the parent's signed PDF (server-side source only — no client URLs).
  const downloaded = await deps.downloadFile(parent.signedPdfUrl);
  if (!downloaded) {
    throw new ContinuationError(
      "parent_pdf_unavailable",
      "The signed PDF for this envelope could not be loaded from storage.",
      409,
    );
  }

  // Strip the parent's certificate pages: the child's working document must
  // not offer certificate pages as field targets, and the child's own stamping
  // pass would drop marker-tagged pages anyway. The parent's full evidence
  // packet stays untouched at the parent's signedPdfUrl.
  const { pdfBytes, pageCount } = await deps.stripCertificatePages(
    Buffer.from(downloaded.data),
  );

  const childPdfUrl = await deps.uploadFile(
    `continuation_${parent.id}_${Date.now()}.pdf`,
    Buffer.from(pdfBytes),
  );

  const subject = input.subject?.trim() || `${parent.subject} — further signature`;
  const continuationSequence = (parent.continuationSequence ?? 0) + 1;

  // Provenance invariant: the child must always pin a non-null parent hash.
  // Legacy signed envelopes may predate documentHash; for those we hash the
  // exact signed artifact we copied (the full stored signed PDF, including
  // its certificate), so the lineage always points at verifiable bytes.
  const parentDocumentHash =
    parent.documentHash ||
    createHash("sha256").update(downloaded.data).digest("hex");

  let child: Envelope;
  try {
    child = await deps.transaction(async (tx) => {
    const env = await storage.createEnvelope(
      {
        subject,
        externalRef: parent.externalRef,
        message: input.message?.trim() || null,
        webhookUrl: null,
        originalPdfUrl: childPdfUrl,
        signedPdfUrl: null,
        totalPages: pageCount,
        status: "draft",
        gmailThreadId: null,
        signaturePlacementMode: parent.signaturePlacementMode ?? "fixed_bottom_centre",
        parentEnvelopeId: parent.id,
        parentDocumentHash,
        continuationSequence,
      },
      tx,
    );

    for (const s of input.signers) {
      await storage.createSigner(
        {
          envelopeId: env.id,
          email: s.email,
          fullName: s.fullName,
          accessToken: deps.generateToken(),
        },
        tx,
      );
    }

    await storage.createAuditEvent(
      {
        envelopeId: env.id,
        eventType: "Continuation envelope created",
        actorEmail: input.actorEmail ?? null,
        ipAddress: input.ipAddress ?? null,
        metadata: JSON.stringify({
          parentEnvelopeId: parent.id,
          parentDocumentHash,
          continuationSequence,
          signers: input.signers.map((s) => s.email),
        }),
      },
      tx,
    );

    await storage.createAuditEvent(
      {
        envelopeId: parent.id,
        eventType: "Sent for further signature",
        actorEmail: input.actorEmail ?? null,
        ipAddress: input.ipAddress ?? null,
        metadata: JSON.stringify({
          continuationEnvelopeId: env.id,
          signers: input.signers.map((s) => s.email),
        }),
      },
      tx,
    );

      return env;
    });
  } catch (err) {
    // Compensating cleanup: the child PDF was uploaded before the DB
    // transaction; if the transaction failed, delete the orphaned object
    // (best-effort) and surface the original error.
    await deps.deleteFile(childPdfUrl).catch(() => {});
    throw err;
  }

  return child;
}
