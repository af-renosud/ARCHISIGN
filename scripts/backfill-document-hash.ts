/**
 * Task #37 — Backfill `envelopes.document_hash` for envelopes signed before the
 * hash column shipped.
 *
 * Walks every envelope with a `signed_pdf_url` and no `document_hash`,
 * downloads the signed PDF from Object Storage, strips any trailing
 * archisign-cert-v1 certificate pages (matching `PdfService.stampSignedPdf`),
 * SHA-256 hashes the remaining signed body, and writes the hash back.
 *
 * Idempotent: re-running skips envelopes that already have a hash.
 *
 * Run once:  npx tsx scripts/backfill-document-hash.ts
 */
import { createHash } from "crypto";
import { and, eq, isNotNull, isNull, asc } from "drizzle-orm";
import { db } from "../server/db";
import { envelopes } from "@shared/schema";
import { downloadFile } from "../server/fileStorage";

async function hashSignedBody(pdfBytes: Buffer): Promise<string> {
  const { PDFDocument } = await import("pdf-lib");
  const pdfDoc = await PDFDocument.load(pdfBytes);

  const existingKeywords = (() => {
    try { return pdfDoc.getKeywords() || ""; } catch { return ""; }
  })();
  const markerMatch = String(existingKeywords).match(/archisign-cert-v1:(\d+)/);
  if (markerMatch) {
    const certPages = Math.max(0, Math.min(pdfDoc.getPageCount(), Number(markerMatch[1])));
    for (let i = 0; i < certPages; i++) {
      pdfDoc.removePage(pdfDoc.getPageCount() - 1);
    }
  }

  const signedBodyBytes = await pdfDoc.save();
  return createHash("sha256").update(Buffer.from(signedBodyBytes)).digest("hex");
}

async function main() {
  const rows = await db.query.envelopes.findMany({
    where: and(isNotNull(envelopes.signedPdfUrl), isNull(envelopes.documentHash)),
    orderBy: [asc(envelopes.id)],
  });

  console.log(`[backfill-document-hash] ${rows.length} envelope(s) to process.`);

  let updated = 0;
  let skippedMissing = 0;
  let failed = 0;

  for (const env of rows) {
    const url = env.signedPdfUrl!;
    try {
      const file = await downloadFile(url);
      if (!file) {
        console.warn(`envelope #${env.id}: signed PDF not found at ${url} — skipping`);
        skippedMissing += 1;
        continue;
      }
      const hash = await hashSignedBody(file.data);
      await db
        .update(envelopes)
        .set({ documentHash: hash, updatedAt: new Date() })
        .where(and(eq(envelopes.id, env.id), isNull(envelopes.documentHash)));
      console.log(`envelope #${env.id}: hash=${hash}`);
      updated += 1;
    } catch (err) {
      failed += 1;
      console.error(`envelope #${env.id}: failed —`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    `[backfill-document-hash] done. updated=${updated} skipped_missing=${skippedMissing} failed=${failed} total=${rows.length}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
