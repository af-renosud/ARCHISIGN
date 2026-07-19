import { storage } from "../storage";
import { downloadFile } from "../fileStorage";
import {
  getAllPageSizes,
  computeFooterInitialPlacements,
} from "./PdfService";
import type { Annotation, Envelope, Signer } from "@shared/schema";

/**
 * Auto-place one initial box per signer in the footer of every page of a
 * draft envelope. Geometry comes from PdfService.computeFooterInitialPlacements
 * (the authoritative coordinate system). Pages where a signer already has a
 * placed initial are skipped so existing hand-placed fields are never
 * duplicated or moved.
 */
export async function autoPlaceFooterInitials(
  envelope: Envelope & { signers: Signer[] },
): Promise<{ created: Annotation[]; skipped: number }> {
  if (!envelope.originalPdfUrl) {
    throw Object.assign(new Error("Envelope has no PDF attached"), { status: 400 });
  }
  const downloaded = await downloadFile(envelope.originalPdfUrl);
  if (!downloaded) {
    throw Object.assign(new Error("Original PDF could not be loaded"), { status: 404 });
  }

  const pageSizes = await getAllPageSizes(Buffer.from(downloaded.data));
  const placements = computeFooterInitialPlacements(pageSizes, envelope.signers.length);

  const existing = await storage.getAnnotationsByEnvelope(envelope.id);
  const hasPlacedInitial = new Set(
    existing
      .filter((a) => a.placed && a.type === "initial")
      .map((a) => `${a.signerId}:${a.pageNumber}`),
  );

  const created: Annotation[] = [];
  let skipped = 0;
  for (const p of placements) {
    const signer = envelope.signers[p.signerIndex];
    if (!signer) continue;
    if (hasPlacedInitial.has(`${signer.id}:${p.pageNumber}`)) {
      skipped++;
      continue;
    }
    created.push(
      await storage.createAnnotation({
        envelopeId: envelope.id,
        signerId: signer.id,
        pageNumber: p.pageNumber,
        xPos: p.xPos,
        yPos: p.yPos,
        width: p.width,
        height: p.height,
        type: "initial",
        value: null,
        placed: true,
      }),
    );
  }
  return { created, skipped };
}
