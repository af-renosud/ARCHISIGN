import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

interface SignerData {
  id: number;
  fullName: string;
  signedAt: Date | string | null;
}

interface AnnotationData {
  pageNumber: number;
  xPos: number;
  yPos: number;
  width?: number | null;
  height?: number | null;
  type: "initial" | "signature" | "date";
  value: string | null;
}

interface SignerWithAnnotations {
  signer: SignerData;
  annotations: AnnotationData[];
}

let cachedScriptFont: Buffer | null = null;

function loadScriptFont(): Buffer {
  if (cachedScriptFont) return cachedScriptFont;
  cachedScriptFont = readFileSync(join(process.cwd(), "server/fonts/DancingScript.ttf"));
  return cachedScriptFont;
}

export async function getPageCount(pdfBuffer: Buffer): Promise<number> {
  const { PDFDocument } = await import("pdf-lib");
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  return pdfDoc.getPageCount();
}

export type SignaturePlacementMode = "fixed_bottom_centre" | "admin_placed";

export async function stampSignedPdf(
  pdfBuffer: Buffer,
  signersWithAnnotations: SignerWithAnnotations[],
  envelopeId: number,
  signaturePlacementMode: SignaturePlacementMode = "fixed_bottom_centre",
): Promise<{ signedPdfBytes: Uint8Array; documentHash: string }> {
  const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");
  const fontkit = (await import("@pdf-lib/fontkit")).default;

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  pdfDoc.registerFontkit(fontkit);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let scriptFont;
  try {
    const scriptFontBytes = loadScriptFont();
    scriptFont = await pdfDoc.embedFont(scriptFontBytes);
  } catch (err) {
    console.warn("Failed to load script font, falling back to Helvetica:", err);
    scriptFont = null;
  }

  for (const { signer, annotations } of signersWithAnnotations) {
    for (const ann of annotations) {
      const pageIndex = ann.pageNumber - 1;
      if (pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) continue;

      const page = pdfDoc.getPage(pageIndex);
      const { width, height } = page.getSize();

      if (ann.type === "signature" && signer.signedAt) {
        const signedAt = new Date(signer.signedAt);
        const dateStr = signedAt.toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        });
        const authId = createHash("sha256")
          .update(`${signer.id}-${envelopeId}-${signer.signedAt}`)
          .digest("hex")
          .substring(0, 12)
          .toUpperCase();

        const boxWidth = ann.width ? ann.width * width : 260;
        const sigNameSize = scriptFont ? Math.min(28, boxWidth * 0.1) : 9;
        const scriptLineHeight = sigNameSize + 4;
        const metaLineHeight = 12;
        const metaLabelSize = 7;
        const titleSize = 8;
        const padding = 8;
        const boxHeight = ann.height
          ? ann.height * height
          : scriptLineHeight + padding + (metaLineHeight * 4) + padding;
        const margin = 10;

        let boxX: number;
        let boxY: number;
        if (signaturePlacementMode === "admin_placed") {
          // Honour admin-placed xPos/yPos. yPos uses top-origin (PDF uses bottom-origin).
          boxX = ann.xPos * width;
          boxY = (1 - ann.yPos) * height - boxHeight;
        } else {
          // Default: force signature box to centre-horizontal, padded 10mm (≈28.35pt) from page bottom.
          const MM_TO_PT = 2.83465;
          const bottomPaddingPt = 10 * MM_TO_PT;
          boxX = (width - boxWidth) / 2;
          boxY = bottomPaddingPt;
        }
        boxX = Math.max(margin, Math.min(boxX, width - boxWidth - margin));
        boxY = Math.max(margin, Math.min(boxY, height - boxHeight - margin));

        // Border drawn fully opaque so the signature frame stays crisp.
        page.drawRectangle({
          x: boxX,
          y: boxY,
          width: boxWidth,
          height: boxHeight,
          borderColor: rgb(0.8, 0, 0),
          borderWidth: 1.5,
          color: rgb(1, 1, 1),
          opacity: 0.10,
          borderOpacity: 1,
        });

        const textX = boxX + padding;
        let textY = boxY + boxHeight - padding - sigNameSize;

        if (scriptFont) {
          page.drawText(signer.fullName, {
            x: textX,
            y: textY,
            size: sigNameSize,
            font: scriptFont,
            color: rgb(0.05, 0.05, 0.3),
          });
        } else {
          page.drawText(signer.fullName, {
            x: textX,
            y: textY,
            size: 12,
            font: fontBold,
            color: rgb(0.05, 0.05, 0.3),
          });
        }

        textY -= scriptLineHeight;

        page.drawLine({
          start: { x: textX, y: textY + 4 },
          end: { x: boxX + boxWidth - padding, y: textY + 4 },
          thickness: 0.5,
          color: rgb(0.6, 0.6, 0.6),
        });

        textY -= 4;

        page.drawText("DIGITAL ENVELOPE", {
          x: textX,
          y: textY,
          size: titleSize,
          font: fontBold,
          color: rgb(0, 0, 0.7),
        });
        textY -= metaLineHeight;

        page.drawText(`SIGNED BY: ${signer.fullName}`, {
          x: textX,
          y: textY,
          size: metaLabelSize,
          font: fontBold,
          color: rgb(0, 0, 0.7),
        });
        textY -= metaLineHeight;

        page.drawText(`DATE: ${dateStr}`, {
          x: textX,
          y: textY,
          size: metaLabelSize,
          font: fontBold,
          color: rgb(0, 0, 0.7),
        });
        textY -= metaLineHeight;

        page.drawText(`AUTHENTICATION: ${authId}`, {
          x: textX,
          y: textY,
          size: metaLabelSize,
          font: fontBold,
          color: rgb(0, 0, 0.7),
        });
      } else if (ann.type === "initial" || ann.type === "date") {
        const text =
          ann.type === "initial"
            ? (ann.value || signer.fullName.split(" ").map(n => n[0]).join("").toUpperCase())
            : (ann.value || "");
        if (!text) continue;

        // Treat (xPos, yPos) as the box top-left fraction (same convention as
        // signature). Honour width/height so the stamped glyphs sit *inside*
        // the editor's rectangle, not anchored to a baseline above it.
        const boxWidthPt =
          ann.width != null ? ann.width * width : (ann.type === "initial" ? 0.08 * width : 0.15 * width);
        const boxHeightPt =
          ann.height != null ? ann.height * height : (ann.type === "initial" ? 0.04 * height : 0.03 * height);
        const boxLeftPt = ann.xPos * width;
        const boxBottomPt = (1 - ann.yPos) * height - boxHeightPt;

        const chosenFont = scriptFont || font;
        // Auto-fit: pick the largest size that fits both the box width and
        // ~80% of the box height. Cap to a sensible maximum so a giant
        // editor box doesn't produce a comically large glyph.
        const maxByHeight = boxHeightPt * 0.8;
        const maxByWidth = (boxWidthPt * 0.95) / Math.max(1, chosenFont.widthOfTextAtSize(text, 1));
        const fontSize = Math.max(6, Math.min(48, maxByHeight, maxByWidth));
        const textWidth = chosenFont.widthOfTextAtSize(text, fontSize);
        const textHeight = chosenFont.heightAtSize(fontSize);
        const textX = boxLeftPt + (boxWidthPt - textWidth) / 2;
        // drawText anchors at the baseline; centre vertically inside the box.
        const textY = boxBottomPt + (boxHeightPt - textHeight) / 2;

        page.drawText(text, {
          x: textX,
          y: textY,
          size: fontSize,
          font: chosenFont,
          color: rgb(0.05, 0.05, 0.3),
        });
      } else {
        page.drawText(`[${ann.value || ""}]`, {
          x: ann.xPos * width,
          y: (1 - ann.yPos) * height,
          size: 7,
          font,
          color: rgb(0.1, 0.1, 0.5),
        });
      }
    }
  }

  const signedPdfBytes = await pdfDoc.save();

  const documentHash = createHash("sha256")
    .update(Buffer.from(signedPdfBytes))
    .digest("hex");

  return { signedPdfBytes, documentHash };
}
