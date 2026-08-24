import type { Envelope } from "@shared/schema";

export const ARCHIDOC_ORIGIN = "archidoc";

export interface PlacementReviewReason {
  code: string;
  message: string;
}

type PlacementEnvelope = Pick<
  Envelope,
  | "origin"
  | "status"
  | "placementReviewState"
  | "placementConfidence"
  | "placementReasons"
  | "placementRevision"
  | "placementApprovedRevision"
>;

export function parsePlacementReasons(value: string | null | undefined): PlacementReviewReason[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((reason): reason is PlacementReviewReason =>
          !!reason &&
          typeof reason.code === "string" &&
          typeof reason.message === "string")
      : [];
  } catch {
    return [];
  }
}

export function placementReviewBlock(envelope: PlacementEnvelope): {
  code: "placement_review_required";
  message: string;
  placementReviewState: string;
  placementConfidence: string | null;
  reasons: PlacementReviewReason[];
} | null {
  if (envelope.origin !== ARCHIDOC_ORIGIN || envelope.status !== "draft") return null;

  const approvalIsCurrent =
    envelope.placementReviewState === "approved" &&
    envelope.placementApprovedRevision === envelope.placementRevision;
  const automaticPlacementIsReady = envelope.placementReviewState === "ready";
  const legacyEnvelopeIsExempt = envelope.placementReviewState === "not_required";

  if (approvalIsCurrent || automaticPlacementIsReady || legacyEnvelopeIsExempt) return null;

  return {
    code: "placement_review_required",
    message: "Signature placement must be reviewed and approved before this Archie Doc envelope can be sent.",
    placementReviewState: envelope.placementReviewState,
    placementConfidence: envelope.placementConfidence,
    reasons: parsePlacementReasons(envelope.placementReasons),
  };
}

export function invalidatedPlacementPatch(
  envelope: Pick<Envelope, "origin" | "placementRevision">,
  reason: PlacementReviewReason,
): Partial<Envelope> | null {
  if (envelope.origin !== ARCHIDOC_ORIGIN) return null;
  return {
    placementReviewState: "review_required",
    placementConfidence: "medium",
    placementReasons: JSON.stringify([reason]),
    placementRevision: envelope.placementRevision + 1,
    placementApprovedRevision: null,
    placementApprovedBy: null,
    placementApprovedAt: null,
  };
}