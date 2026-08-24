import { Router } from "express";
import crypto from "crypto";
import { storage } from "../storage";
import { db } from "../db";
import { createApiEnvelopeRequestSchema } from "@shared/schema";
import { uploadFile, deleteFile, downloadFile } from "../fileStorage";
import {
  getPageCount,
  getPageSize,
  getAllPageSizes,
  computeFooterInitialPlacements,
  resolveAnchorPlacements,
  resolveExactTextPlacements,
  ANCHOR_DEFAULT_BOX,
  ANCHOR_MAX_MATCHES_PER_ANCHOR,
  ANCHOR_MAX_MATCHES_PER_ENVELOPE,
  type AnchorMatch,
} from "../services/PdfService";
import { generateToken } from "../services/SecurityService";
import { sendSigningInvitation, loadEmailSettings } from "../services/NotificationService";
import { emitEvent } from "../services/EventDispatcher";
import { ContactService } from "../services/ContactService";
import { asyncHandler } from "../middleware/asyncHandler";
import { apiKeyAuth } from "../middleware/apiKeyAuth";
import { rateLimit } from "../middleware/rateLimit";
import { safeFetch, assertSafeUrl } from "../utils/ssrfGuard";
import { placementReviewBlock, type PlacementReviewReason } from "../services/PlacementReviewService";

const PDF_FETCH_TIMEOUT_MS = 60_000;
const PDF_MAX_BYTES = 25 * 1024 * 1024;
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
const EXPIRES_AT_FLOOR_MS = 60_000;
// v1.4 §3.5.1.1(b): sender body cap, counted in Unicode code points (not UTF-16 units).
const BODY_MAX_CODE_POINTS = 2000;

function signedUrlSecret(): string {
  const secret = process.env.ARCHISIGN_SIGNED_URL_SECRET || process.env.ARCHISIGN_WEBHOOK_SECRET;
  if (!secret) {
    // Refuse to mint or verify URLs with a guessable secret. Operators must
    // set ARCHISIGN_SIGNED_URL_SECRET (or fall through to ARCHISIGN_WEBHOOK_SECRET).
    // Both `status` and `statusCode` are set so that the global error middleware
    // (`err.status || err.statusCode`) surfaces this as a 503.
    console.error("[v1Envelopes] CRITICAL: ARCHISIGN_SIGNED_URL_SECRET (or ARCHISIGN_WEBHOOK_SECRET) is not configured; refusing to mint /signed-pdf-fetch URL");
    throw Object.assign(
      new Error("Signed-URL secret is not configured on this server"),
      { status: 503, statusCode: 503 },
    );
  }
  return secret;
}

export function mintSignedPdfUrl(envelopeId: number, baseUrl: string): { url: string; expiresAt: string } {
  const exp = Date.now() + SIGNED_URL_TTL_MS;
  const sig = crypto.createHmac("sha256", signedUrlSecret())
    .update(`${envelopeId}.${exp}`)
    .digest("hex");
  const url = `${baseUrl}/api/v1/envelopes/${envelopeId}/signed-pdf-fetch?exp=${exp}&sig=${sig}`;
  return { url, expiresAt: new Date(exp).toISOString() };
}

function verifySignedPdfUrl(envelopeId: number, exp: string, sig: string): boolean {
  const expNum = Number.parseInt(exp, 10);
  if (!Number.isFinite(expNum) || Date.now() > expNum) return false;
  const expected = crypto.createHmac("sha256", signedUrlSecret())
    .update(`${envelopeId}.${exp}`)
    .digest("hex");
  if (expected.length !== sig.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

async function fetchPdfFromUrl(url: string): Promise<Buffer> {
  const response = await safeFetch(url, "pdfFetchUrl", {
    signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`pdfFetchUrl returned ${response.status}`), { httpStatus: 400 });
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > PDF_MAX_BYTES) {
    throw Object.assign(new Error("PDF exceeds 25 MiB limit"), { httpStatus: 413 });
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.byteLength > PDF_MAX_BYTES) {
    throw Object.assign(new Error("PDF exceeds 25 MiB limit"), { httpStatus: 413 });
  }
  return buf;
}

function buildAccessUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/sign/${token}`;
}

export function buildV1EnvelopesRouter(): Router {
  const router = Router();

  router.use(apiKeyAuth);

  /**
   * POST /api/v1/envelopes/create — §3.5.1
   */
  router.post("/envelopes/create", rateLimit("create"), asyncHandler(async (req, res) => {
    const parsed = createApiEnvelopeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", fieldErrors: parsed.error.flatten().fieldErrors });
    }
    const data = parsed.data;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    // v1.4 §3.5.1.1(b): reject over-length body outright — no silent truncation.
    if (typeof data.body === "string" && Array.from(data.body).length > BODY_MAX_CODE_POINTS) {
      return res.status(400).json({
        error: "body_too_long",
        message: `body exceeds ${BODY_MAX_CODE_POINTS} Unicode code points`,
      });
    }

    if (data.expiresAt) {
      const expMs = new Date(data.expiresAt).getTime();
      if (!Number.isFinite(expMs) || expMs < Date.now() + EXPIRES_AT_FLOOR_MS) {
        return res.status(400).json({ error: "invalid_request", message: "expiresAt must be at least 1 minute in the future" });
      }
    }

    if (data.webhookUrl) {
      try {
        await assertSafeUrl(data.webhookUrl, "webhookUrl");
      } catch (err: any) {
        return res.status(400).json({ error: "invalid_request", message: err.message });
      }
    }

    let savedPdfUrl: string | null = data.pdfUrl || null;
    let totalPages = 1;
    let mintedFromFetch = false;
    let pdfBuf: Buffer | null = null;

    if (data.pdfFetchUrl) {
      try {
        const buf = await fetchPdfFromUrl(data.pdfFetchUrl);
        totalPages = await getPageCount(buf);
        const fileName = `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`;
        savedPdfUrl = await uploadFile(fileName, buf);
        mintedFromFetch = true;
        pdfBuf = buf;
      } catch (err: any) {
        const status = err.httpStatus || (err.name === "TimeoutError" ? 400 : 503);
        const code = status === 413 ? "pdf_too_large" : status === 503 ? "vault_transient" : "pdf_fetch_failed";
        return res.status(status).json({ error: code, message: err.message });
      }
    } else if (data.pdfBase64) {
      let buf: Buffer;
      try {
        buf = Buffer.from(data.pdfBase64, "base64");
        totalPages = await getPageCount(buf);
      } catch (err: any) {
        return res.status(400).json({ error: "invalid_pdf", message: err.message });
      }
      if (buf.byteLength > PDF_MAX_BYTES) {
        return res.status(413).json({ error: "pdf_too_large", message: "PDF exceeds 25 MiB limit" });
      }
      const fileName = `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`;
      savedPdfUrl = await uploadFile(fileName, buf);
      mintedFromFetch = true;
      pdfBuf = buf;
    }

    const signerList = (data.signers && data.signers.length > 0)
      ? data.signers
      : [{ email: data.signerEmail!, fullName: data.signerName || data.signerEmail! }];

    // v1.5 anchor-based placement: resolve anchors against the PDF text layer
    // BEFORE the transaction so a resolution failure can degrade gracefully
    // (warning + appended-page fallback) without touching the DB.
    type SignerInput = (typeof signerList)[number] & {
      anchor?: string;
      anchorOffset?: { x: number; y: number };
      size?: { width: number; height: number };
    };
    const signerInputs = signerList as SignerInput[];
    const anchoredInputs = signerInputs.filter(s => typeof s.anchor === "string" && s.anchor.length > 0);
    const warnings: Array<{ code: string; signerEmail: string; anchor?: string; message: string }> = [];
    let anchorMatches: Map<string, AnchorMatch[]> | null = null;

    if (anchoredInputs.length > 0) {
      if (!pdfBuf) {
        for (const s of anchoredInputs) {
          warnings.push({
            code: "anchor_source_unsupported",
            signerEmail: s.email,
            anchor: s.anchor!,
            message: "Anchors require pdfBase64 or pdfFetchUrl; falling back to appended signature page",
          });
        }
      } else {
        try {
          anchorMatches = await resolveAnchorPlacements(pdfBuf, anchoredInputs.map(s => s.anchor!));
        } catch (err: any) {
          for (const s of anchoredInputs) {
            warnings.push({
              code: "anchor_resolution_failed",
              signerEmail: s.email,
              anchor: s.anchor!,
              message: `Text-layer extraction failed (${err?.message || err}); falling back to appended signature page`,
            });
          }
        }
      }
    }

    // Project each resolved anchor occurrence into a normalized annotation
    // (same top-left-origin fractional convention PdfService stamps with).
    type PendingAnnotation = {
      signerIndex: number;
      pageNumber: number;
      xPos: number;
      yPos: number;
      width: number;
      height: number;
    };
    const pendingAnnotations: PendingAnnotation[] = [];
    let totalAnchorPlacements = 0;

    if (anchorMatches) {
      for (let i = 0; i < signerInputs.length; i++) {
        const s = signerInputs[i];
        if (!s.anchor) continue;
        const matches = anchorMatches.get(s.anchor) || [];
        if (matches.length === 0) {
          warnings.push({
            code: "anchor_not_found",
            signerEmail: s.email,
            anchor: s.anchor,
            message: "Anchor string not found in PDF text layer; falling back to appended signature page",
          });
          continue;
        }
        if (matches.length >= ANCHOR_MAX_MATCHES_PER_ANCHOR) {
          warnings.push({
            code: "anchor_matches_truncated",
            signerEmail: s.email,
            anchor: s.anchor,
            message: `Per-anchor cap of ${ANCHOR_MAX_MATCHES_PER_ANCHOR} occurrences reached; extra occurrences ignored`,
          });
        }
        const requestedWidth = s.size?.width ?? ANCHOR_DEFAULT_BOX.width;
        const requestedHeight = s.size?.height ?? ANCHOR_DEFAULT_BOX.height;
        const dx = s.anchorOffset?.x ?? 0;
        const dy = s.anchorOffset?.y ?? 0;
        for (const m of matches) {
          if (totalAnchorPlacements >= ANCHOR_MAX_MATCHES_PER_ENVELOPE) {
            warnings.push({
              code: "anchor_matches_truncated",
              signerEmail: s.email,
              anchor: s.anchor,
              message: `Envelope-wide cap of ${ANCHOR_MAX_MATCHES_PER_ENVELOPE} anchored placements reached; extra occurrences ignored`,
            });
            break;
          }
          const margin = 10;
          const w = Math.min(requestedWidth, Math.max(1, m.pageWidth - margin * 2));
          const h = Math.min(requestedHeight, Math.max(1, m.pageHeight - margin * 2));
          const requestedX = m.x + dx;
          const requestedY = m.y + dy;
          const bx = Math.max(margin, Math.min(requestedX, m.pageWidth - w - margin));
          const by = Math.max(margin, Math.min(requestedY, m.pageHeight - h - margin));
          if (
            Math.abs(bx - requestedX) > 0.01 ||
            Math.abs(by - requestedY) > 0.01 ||
            w !== requestedWidth ||
            h !== requestedHeight
          ) {
            warnings.push({
              code: "anchor_box_clamped",
              signerEmail: s.email,
              anchor: s.anchor,
              message: "Anchor box was adjusted to fit the page margin; placement review is required",
            });
          }
          pendingAnnotations.push({
            signerIndex: i,
            pageNumber: m.pageNumber,
            xPos: bx / m.pageWidth,
            yPos: 1 - (by + h) / m.pageHeight,
            width: w / m.pageWidth,
            height: h / m.pageHeight,
          });
          totalAnchorPlacements++;
        }
      }
    }

    const placementReasons: PlacementReviewReason[] = [];
    const inferredSignerIndexes = new Set<number>();
    let inferredPlacementCount = 0;
    const unanchoredNameCounts = new Map<string, number>();
    for (const signer of signerInputs.filter((candidate) => !candidate.anchor)) {
      const identityKey = signer.fullName.trim().toLocaleLowerCase();
      unanchoredNameCounts.set(identityKey, (unanchoredNameCounts.get(identityKey) || 0) + 1);
    }
    const duplicatedUnanchoredNames = new Set(
      Array.from(unanchoredNameCounts.entries())
        .filter(([, count]) => count > 1)
        .map(([identityKey]) => identityKey),
    );
    for (const identityKey of Array.from(duplicatedUnanchoredNames)) {
      const signerName = signerInputs.find((signer) =>
        !signer.anchor && signer.fullName.trim().toLocaleLowerCase() === identityKey)?.fullName;
      placementReasons.push({
        code: "duplicate_signer_identity",
        message: `${signerName || "A signer name"} is shared by multiple unanchored signers, so layout evidence cannot assign their fields safely.`,
      });
    }

    // Strict text-layout fallback for digitally generated PDFs without
    // signer-specific anchors. It only accepts an exact signer-name occurrence
    // with one nearby Signature caption below it; anything less certain remains
    // review-required. The anchor route above always takes precedence.
    if (req.apiKeyAuth!.tenant === "archidoc" && pdfBuf) {
      const unanchoredSignerIndexes = signerInputs
        .map((signer, index) => ({ signer, index }))
        .filter(({ signer }) =>
          !signer.anchor &&
          !duplicatedUnanchoredNames.has(signer.fullName.trim().toLocaleLowerCase()));
      if (unanchoredSignerIndexes.length > 0) {
        try {
          const captionVariants = ["Signature", "SIGNATURE", "signature"];
          const exactNames = await resolveExactTextPlacements(
            pdfBuf,
            unanchoredSignerIndexes.map(({ signer }) => signer.fullName),
          );
          const evidence = await resolveExactTextPlacements(pdfBuf, captionVariants);
          const captionMatches = captionVariants
            .flatMap((caption) => evidence.get(caption) || [])
            .filter((match, index, matches) =>
              matches.findIndex((candidate) =>
                candidate.pageNumber === match.pageNumber &&
                Math.abs(candidate.x - match.x) < 1 &&
                Math.abs(candidate.y - match.y) < 1) === index);
          const usedCaptions = new Set<number>();

          for (const { signer, index: signerIndex } of unanchoredSignerIndexes) {
            const nameMatches = exactNames.get(signer.fullName) || [];
            if (nameMatches.length !== 1) {
              placementReasons.push({
                code: nameMatches.length === 0 ? "signer_name_not_found" : "signer_name_ambiguous",
                message: nameMatches.length === 0
                  ? `${signer.fullName}'s name was not found in the PDF layout.`
                  : `${signer.fullName}'s name appeared ${nameMatches.length} times in the PDF layout.`,
              });
              continue;
            }

            const nameMatch = nameMatches[0];
            const candidates = captionMatches
              .map((caption, captionIndex) => ({ caption, captionIndex }))
              .filter(({ caption, captionIndex }) => {
                if (usedCaptions.has(captionIndex) || caption.pageNumber !== nameMatch.pageNumber) return false;
                const verticalGap = nameMatch.y - caption.y;
                const horizontalGap = Math.abs(nameMatch.x - caption.x);
                return verticalGap >= 8 && verticalGap <= 250 && horizontalGap <= 180;
              });
            if (candidates.length !== 1) {
              placementReasons.push({
                code: candidates.length === 0 ? "signature_caption_not_found" : "signature_caption_ambiguous",
                message: candidates.length === 0
                  ? `No unique Signature caption was found below ${signer.fullName}.`
                  : `More than one Signature caption could belong to ${signer.fullName}.`,
              });
              continue;
            }

            const { caption, captionIndex } = candidates[0];
            const margin = 10;
            const requestedWidth = Math.min(220, caption.pageWidth * 0.4);
            const requestedHeight = 84;
            const bx = Math.max(margin, Math.min(caption.x, caption.pageWidth - requestedWidth - margin));
            const by = Math.max(margin, Math.min(caption.y + 14, caption.pageHeight - requestedHeight - margin));
            if (
              Math.abs(bx - caption.x) > 0.01 ||
              Math.abs(by - (caption.y + 14)) > 0.01
            ) {
              placementReasons.push({
                code: "layout_box_clamped",
                message: `${signer.fullName}'s inferred signature box required a page-boundary adjustment.`,
              });
            }
            pendingAnnotations.push({
              signerIndex,
              pageNumber: caption.pageNumber,
              xPos: bx / caption.pageWidth,
              yPos: 1 - (by + requestedHeight) / caption.pageHeight,
              width: requestedWidth / caption.pageWidth,
              height: requestedHeight / caption.pageHeight,
            });
            usedCaptions.add(captionIndex);
            inferredSignerIndexes.add(signerIndex);
            inferredPlacementCount += 1;
          }
        } catch (err: any) {
          placementReasons.push({
            code: "layout_inference_failed",
            message: `The PDF layout could not be analysed (${err?.message || err}).`,
          });
        }
      }
    }

    const placedSignerIndexes = new Set(pendingAnnotations.map(p => p.signerIndex));
    const useAdminPlacement = placedSignerIndexes.size > 0;
    let placementReviewState: "not_required" | "ready" | "review_required" = "not_required";
    let placementConfidence: "high" | "low" | null = null;
    if (req.apiKeyAuth!.tenant === "archidoc") {
      const anchorOwners = new Map<string, string[]>();
      for (const signer of signerInputs) {
        if (!signer.anchor) continue;
        const owners = anchorOwners.get(signer.anchor) || [];
        owners.push(signer.fullName);
        anchorOwners.set(signer.anchor, owners);
      }
      anchorOwners.forEach((owners, anchor) => {
        if (owners.length > 1) {
          placementReasons.push({
            code: "signer_anchor_reused",
            message: `The anchor ${anchor} was assigned to more than one signer.`,
          });
        }
      });

      for (let i = 0; i < signerInputs.length; i++) {
        const signer = signerInputs[i];
        if (!signer.anchor) {
          if (!inferredSignerIndexes.has(i) && !placementReasons.some((reason) => reason.message.includes(signer.fullName))) {
            placementReasons.push({
              code: "signer_anchor_missing",
              message: `${signer.fullName} has no signer-specific placement anchor or unambiguous layout match.`,
            });
          }
          continue;
        }
        const matchCount = anchorMatches?.get(signer.anchor)?.length ?? 0;
        if (matchCount === 0) {
          placementReasons.push({
            code: "signer_anchor_unresolved",
            message: `${signer.fullName}'s placement anchor was not resolved in the final PDF.`,
          });
        } else if (matchCount > 1) {
          placementReasons.push({
            code: "signer_anchor_ambiguous",
            message: `${signer.fullName}'s placement anchor matched ${matchCount} locations.`,
          });
        }
      }
      for (const warning of warnings.filter((warning) => warning.code.startsWith("anchor_"))) {
        if (!placementReasons.some((reason) => reason.code === warning.code && reason.message === warning.message)) {
          placementReasons.push({ code: warning.code, message: warning.message });
        }
      }

      for (let i = 0; i < pendingAnnotations.length; i++) {
        for (let j = i + 1; j < pendingAnnotations.length; j++) {
          const a = pendingAnnotations[i];
          const b = pendingAnnotations[j];
          if (a.signerIndex === b.signerIndex || a.pageNumber !== b.pageNumber) continue;
          const overlapWidth = Math.max(0, Math.min(a.xPos + a.width, b.xPos + b.width) - Math.max(a.xPos, b.xPos));
          const overlapHeight = Math.max(0, Math.min(a.yPos + a.height, b.yPos + b.height) - Math.max(a.yPos, b.yPos));
          const overlapArea = overlapWidth * overlapHeight;
          const smallerArea = Math.min(a.width * a.height, b.width * b.height);
          if (smallerArea > 0 && overlapArea > 0.000001) {
            placementReasons.push({
              code: "signature_fields_overlap",
              message: "Automatically placed signature fields overlap and must be reviewed.",
            });
          }
        }
      }

      if (placementReasons.length === 0 && signerInputs.length > 0) {
        placementReviewState = "ready";
        placementConfidence = "high";
        if (inferredPlacementCount > 0) {
          placementReasons.push({
            code: "signer_name_and_caption_resolved",
            message: `${inferredPlacementCount} signer${inferredPlacementCount === 1 ? "" : "s"} matched one printed name and one nearby Signature caption.`,
          });
        }
        if (totalAnchorPlacements > 0) {
          placementReasons.push({
            code: "signer_specific_anchors_resolved",
            message: `${totalAnchorPlacements} signer-specific anchor${totalAnchorPlacements === 1 ? "" : "s"} resolved exactly once.`,
          });
        }
        placementReasons.push({
          code: "placement_geometry_valid",
          message: "Every automatic signature box fits inside its PDF page without adjustment or overlap.",
        });
      } else {
        placementReviewState = "review_required";
        placementConfidence = "low";
      }
    }

    // Mixed envelopes: signers without a resolved anchor get a synthetic
    // bottom-centred box on the last page so their output matches today's
    // fixed-bottom behaviour even though the envelope runs in admin_placed mode.
    if (useAdminPlacement && pdfBuf) {
      const MM_TO_PT = 2.83465;
      const { width: pw, height: ph } = await getPageSize(pdfBuf, totalPages);
      const w = ANCHOR_DEFAULT_BOX.width;
      const h = ANCHOR_DEFAULT_BOX.height;
      for (let i = 0; i < signerInputs.length; i++) {
        if (placedSignerIndexes.has(i)) continue;
        pendingAnnotations.push({
          signerIndex: i,
          pageNumber: totalPages,
          xPos: (pw - w) / 2 / pw,
          yPos: 1 - (10 * MM_TO_PT + h) / ph,
          width: w / pw,
          height: h / ph,
        });
      }
    }

    // v1.6 additive: auto-place one footer initial box per signer on every
    // page (same geometry the admin-UI checkbox uses). Requires a PDF buffer;
    // pdfUrl-only envelopes degrade with a warning and no initial boxes.
    type PendingInitial = {
      signerIndex: number;
      pageNumber: number;
      xPos: number;
      yPos: number;
      width: number;
      height: number;
    };
    let pendingInitials: PendingInitial[] = [];
    if (data.autoPlaceInitials) {
      if (!pdfBuf) {
        for (const s of signerInputs) {
          warnings.push({
            code: "initials_source_unsupported",
            signerEmail: s.email,
            message: "autoPlaceInitials requires pdfBase64 or pdfFetchUrl; no initial boxes were placed",
          });
        }
      } else {
        const pageSizes = await getAllPageSizes(pdfBuf);
        pendingInitials = computeFooterInitialPlacements(pageSizes, signerInputs.length);
      }
    }

    // v1.4 §3.5.1.1(a): empty/whitespace-after-trim subject falls back to the
    // default; otherwise the caller's string is used verbatim (framed by the
    // firm-name prefix at send time — the contiguous-substring guarantee).
    const callerSubject = typeof data.subject === "string" ? data.subject.trim() : "";
    const subject = callerSubject.length > 0 ? data.subject! : "Document for signature";
    const senderMessage = data.body && data.body.trim() ? data.body.trim() : null;

    let envelope: { id: number; createdAt: Date; expiresAt: Date | null; status: string };
    let createdSigners: Array<{ id: number; accessToken: string; email: string }>;
    try {
      const result = await db.transaction(async (tx) => {
        const env = await storage.createEnvelope({
          subject,
          externalRef: data.externalRef || null,
          webhookUrl: data.webhookUrl || null,
          originalPdfUrl: savedPdfUrl,
          signedPdfUrl: null,
          totalPages,
          status: "draft",
          gmailThreadId: null,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
          origin: req.apiKeyAuth!.tenant,
          message: senderMessage,
          signaturePlacementMode: useAdminPlacement ? "admin_placed" : "fixed_bottom_centre",
          placementReviewState,
          placementConfidence,
          placementReasons: placementReasons.length > 0 ? JSON.stringify(placementReasons) : null,
          placementRevision: 0,
        } as any, tx);

        const signers: Array<{ id: number; accessToken: string; email: string }> = [];
        for (let i = 0; i < signerInputs.length; i++) {
          const s = signerInputs[i];
          const token = generateToken();
          const created = await storage.createSigner({
            envelopeId: env.id,
            email: s.email,
            fullName: s.fullName,
            accessToken: token,
          }, tx);
          signers.push({ id: created.id, accessToken: token, email: s.email });

          for (const p of pendingAnnotations.filter(pa => pa.signerIndex === i)) {
            await storage.createAnnotation({
              envelopeId: env.id,
              signerId: created.id,
              pageNumber: p.pageNumber,
              xPos: p.xPos,
              yPos: p.yPos,
              width: p.width,
              height: p.height,
              type: "signature",
              value: null,
              placed: true,
            }, tx);
          }

          for (const p of pendingInitials.filter(pi => pi.signerIndex === i)) {
            await storage.createAnnotation({
              envelopeId: env.id,
              signerId: created.id,
              pageNumber: p.pageNumber,
              xPos: p.xPos,
              yPos: p.yPos,
              width: p.width,
              height: p.height,
              type: "initial",
              value: null,
              placed: true,
            }, tx);
          }
        }

        await storage.createAuditEvent({
          envelopeId: env.id,
          eventType: "Envelope created via API",
          actorEmail: null,
          ipAddress: req.ip || null,
          metadata: JSON.stringify({
            tenant: req.apiKeyAuth!.tenant,
            signerCount: signerList.length,
            pdfSource: data.pdfFetchUrl ? "pdfFetchUrl" : data.pdfBase64 ? "pdfBase64" : "pdfUrl",
            externalRef: data.externalRef || null,
            anchoredPlacements: totalAnchorPlacements,
            inferredPlacements: inferredPlacementCount || undefined,
            placementReviewState,
            placementConfidence,
            placementReasons,
            autoPlacedInitials: pendingInitials.length > 0 ? pendingInitials.length : undefined,
            anchorWarnings: warnings.length > 0 ? warnings : undefined,
          }),
        }, tx);

        return { env, signers };
      });
      envelope = result.env;
      createdSigners = result.signers;
      try {
        await ContactService.bumpLastUsed(createdSigners.map(s => s.email));
      } catch (bumpErr: any) {
        console.warn(`[v1.create] bumpLastUsed failed for envelope ${envelope.id}: ${bumpErr?.message || bumpErr}`);
      }
    } catch (txErr) {
      if (savedPdfUrl && mintedFromFetch) {
        await deleteFile(savedPdfUrl).catch(() => {});
      }
      throw txErr;
    }

    res.status(201).json({
      envelopeId: envelope.id,
      status: envelope.status,
      createdAt: envelope.createdAt,
      expiresAt: envelope.expiresAt,
      signers: createdSigners.map(s => ({
        id: s.id,
        accessToken: s.accessToken,
        accessUrl: buildAccessUrl(baseUrl, s.accessToken),
        otpDestination: s.email,
      })),
      // v1.4 §3.5.1.1(c): additive echo of what the invitation email will render.
      emailRendering: {
        subjectApplied: callerSubject.length > 0,
        bodyApplied: senderMessage !== null,
      },
      ...(req.apiKeyAuth!.tenant === "archidoc" ? {
        placementReview: {
          state: placementReviewState,
          confidence: placementConfidence,
          reasons: placementReasons,
          automaticSendAllowed: placementReviewState === "ready",
        },
      } : {}),
      // v1.5 additive: anchor resolution warnings (omitted when clean).
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  }));

  /**
   * POST /api/v1/envelopes/:envelopeId/send — §3.5.2 idempotent
   *
   * On first call: dispatches signer invitation emails, transitions the
   * envelope to `sent`, and emits a single `envelope.sent` webhook (per §3.7
   * single-receiver). On re-send while in {sent,viewed,queried}: 200 with the
   * original sentAt and no side-effects. On terminal {signed,declined,expired,
   * void}: 409.
   */
  router.post("/envelopes/:envelopeId/send", rateLimit("send"), asyncHandler(async (req, res) => {
    const envelopeId = Number.parseInt(req.params.envelopeId, 10);
    if (!Number.isFinite(envelopeId)) {
      return res.status(400).json({ error: "invalid_request", message: "envelopeId must be an integer" });
    }
    const envelope = await storage.getEnvelope(envelopeId);
    if (!envelope || envelope.origin !== req.apiKeyAuth!.tenant) {
      return res.status(404).json({ error: "envelope_not_found" });
    }

    const terminalStates = new Set(["signed", "declined", "expired", "void"]);
    if (terminalStates.has(envelope.status)) {
      return res.status(409).json({
        error: "envelope_terminal",
        envelopeId,
        status: envelope.status,
        message: `Envelope is in terminal state '${envelope.status}'; /send is non-idempotent past terminal`,
      });
    }

    const idempotentStates = new Set(["sent", "viewed", "queried"]);
    const wasAlreadySent = idempotentStates.has(envelope.status);

    if (wasAlreadySent) {
      const refreshed = await storage.getEnvelope(envelopeId);
      return res.status(200).json({
        envelopeId,
        status: refreshed?.status ?? envelope.status,
        sentAt: envelope.updatedAt,
      });
    }

    const placementBlock = placementReviewBlock(envelope);
    if (placementBlock) {
      return res.status(409).json({ error: placementBlock.code, ...placementBlock, envelopeId });
    }

    // Race-tight transition: only one caller transitions draft → sent.
    // Concurrent callers fall through to the idempotent 200 branch with no
    // duplicate emails or webhook emissions.
    const sentAt = new Date();
    const claimed = await storage.atomicClaimEnvelopeSend(envelopeId, sentAt);
    if (!claimed) {
      const refreshed = await storage.getEnvelope(envelopeId);
      const refreshedStatus = refreshed?.status ?? "sent";
      const refreshedPlacementBlock = refreshed ? placementReviewBlock(refreshed) : null;
      if (refreshedPlacementBlock) {
        return res.status(409).json({
          error: refreshedPlacementBlock.code,
          ...refreshedPlacementBlock,
          envelopeId,
        });
      }
      if (terminalStates.has(refreshedStatus)) {
        return res.status(409).json({
          error: "envelope_terminal",
          envelopeId,
          status: refreshedStatus,
          message: `Envelope is in terminal state '${refreshedStatus}'; /send is non-idempotent past terminal`,
        });
      }
      return res.status(200).json({
        envelopeId,
        status: refreshedStatus,
        sentAt: refreshed?.updatedAt ?? sentAt,
      });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const emailCfg = await loadEmailSettings();

    const emailResults: { signerId: number; success: boolean; threadId: string | null; error: string | null }[] = [];
    for (const signer of envelope.signers) {
      try {
        const r = await sendSigningInvitation(
          { email: signer.email, fullName: signer.fullName, accessToken: signer.accessToken },
          { id: envelope.id, subject: envelope.subject, externalRef: envelope.externalRef, message: envelope.message, gmailThreadId: envelope.gmailThreadId },
          baseUrl,
          emailCfg,
        );
        emailResults.push({ signerId: signer.id, success: true, threadId: r.threadId ?? null, error: null });
      } catch (err: any) {
        emailResults.push({ signerId: signer.id, success: false, threadId: null, error: err?.message || String(err) });
      }
    }

    // Status was already transitioned by atomicClaimEnvelopeSend above; we only
    // record the audit event here (post-side-effects so emailResults are captured).
    await storage.createAuditEvent({
      envelopeId,
      eventType: "Envelope sent via API",
      actorEmail: null,
      ipAddress: req.ip || null,
      metadata: JSON.stringify({
        tenant: req.apiKeyAuth!.tenant,
        idempotencyKey: req.headers["idempotency-key"] || null,
        emailResults,
      }),
    });

    if (envelope.webhookUrl) {
      try {
        await emitEvent({
          webhookUrl: envelope.webhookUrl,
          envelope: { id: envelope.id, externalRef: envelope.externalRef, origin: envelope.origin },
          eventData: {
            event: "envelope.sent",
            signers: envelope.signers.map(s => ({ email: s.email, name: s.fullName })),
          },
          occurredAt: sentAt,
          tenantKey: envelope.origin || undefined,
        });
      } catch (err: any) {
        console.error(`[v1.send] envelope.sent emit failed for envelope ${envelopeId}: ${err?.message || err}`);
      }
    }

    const refreshed = await storage.getEnvelope(envelopeId);
    res.status(200).json({
      envelopeId,
      status: refreshed?.status ?? "sent",
      sentAt,
    });
  }));

  /**
   * GET /api/v1/envelopes/:envelopeId/signed-pdf-url — §3.5.3
   */
  router.get("/envelopes/:envelopeId/signed-pdf-url", rateLimit("read"), asyncHandler(async (req, res) => {
    const envelopeId = Number.parseInt(req.params.envelopeId, 10);
    if (!Number.isFinite(envelopeId)) {
      return res.status(400).json({ error: "invalid_request", message: "envelopeId must be an integer" });
    }
    const envelope = await storage.getEnvelope(envelopeId);
    if (!envelope || envelope.origin !== req.apiKeyAuth!.tenant) {
      return res.status(404).json({ error: "envelope_not_found" });
    }

    if (envelope.retentionBreachAt) {
      // Use the latest signedAt across signers as the authoritative
      // originalSignedAt (§3.8 retention_breach body).
      const signedAtCandidates = envelope.signers
        .map(s => s.signedAt)
        .filter((d): d is Date => !!d);
      const originalSignedAt = signedAtCandidates.length > 0
        ? new Date(Math.max(...signedAtCandidates.map(d => d.getTime()))).toISOString()
        : envelope.updatedAt.toISOString();
      return res.status(410).json({
        error: "retention_breach",
        envelopeId,
        originalSignedAt,
        detectedAt: (envelope.retentionDetectedAt ?? envelope.retentionBreachAt).toISOString(),
        incidentRef: envelope.retentionIncidentRef ?? "INC-UNKNOWN",
        remediationContact: process.env.ARCHISIGN_RETENTION_REMEDIATION_CONTACT || "vault-ops@archisign.fr",
      });
    }

    if (envelope.status !== "signed" || !envelope.signedPdfUrl) {
      return res.status(409).json({
        error: "envelope_not_signed",
        envelopeId,
        status: envelope.status,
      });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const { url, expiresAt } = mintSignedPdfUrl(envelopeId, baseUrl);
    res.status(200).json({ url, expiresAt });
  }));

  return router;
}

/**
 * Companion endpoint that streams the signed PDF when invoked with a valid
 * mint signature from /signed-pdf-url. NOT mounted under apiKeyAuth — the
 * HMAC sig+exp is the auth.
 */
export function buildSignedPdfFetchHandler() {
  return asyncHandler(async (req: any, res: any) => {
    const envelopeId = Number.parseInt(req.params.envelopeId, 10);
    const exp = String(req.query.exp || "");
    const sig = String(req.query.sig || "");
    if (!Number.isFinite(envelopeId) || !exp || !sig) {
      return res.status(400).json({ error: "invalid_request" });
    }
    if (!verifySignedPdfUrl(envelopeId, exp, sig)) {
      return res.status(401).json({ error: "invalid_signature_or_expired" });
    }
    const envelope = await storage.getEnvelope(envelopeId);
    if (!envelope || !envelope.signedPdfUrl) {
      return res.status(404).json({ error: "signed_pdf_not_found" });
    }
    if (envelope.retentionBreachAt) {
      return res.status(410).json({
        error: "retention_breach",
        envelopeId,
        incidentRef: envelope.retentionIncidentRef ?? "INC-UNKNOWN",
      });
    }
    const file = await downloadFile(envelope.signedPdfUrl);
    if (!file) return res.status(404).json({ error: "signed_pdf_not_found" });
    res.setHeader("Content-Type", file.contentType || "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="envelope-${envelopeId}-signed.pdf"`);
    res.send(file.data);
  });
}
