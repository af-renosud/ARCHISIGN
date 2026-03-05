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

export async function stampSignedPdf(
  pdfBuffer: Buffer,
  signersWithAnnotations: SignerWithAnnotations[],
  envelopeId: number,
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

        let boxX = ann.xPos * width;
        let boxY = (1 - ann.yPos) * height - boxHeight;
        boxX = Math.max(margin, Math.min(boxX, width - boxWidth - margin));
        boxY = Math.max(margin, Math.min(boxY, height - boxHeight - margin));

        page.drawRectangle({
          x: boxX,
          y: boxY,
          width: boxWidth,
          height: boxHeight,
          borderColor: rgb(0.8, 0, 0),
          borderWidth: 1.5,
          color: rgb(1, 1, 1),
          opacity: 0.95,
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
      } else if (ann.type === "initial") {
        const initials = ann.value || signer.fullName.split(" ").map(n => n[0]).join("").toUpperCase();
        if (scriptFont) {
          const initSize = 16;
          page.drawText(initials, {
            x: ann.xPos * width,
            y: (1 - ann.yPos) * height,
            size: initSize,
            font: scriptFont,
            color: rgb(0.05, 0.05, 0.3),
          });
        } else {
          page.drawText(`[${initials}]`, {
            x: ann.xPos * width,
            y: (1 - ann.yPos) * height,
            size: 7,
            font,
            color: rgb(0.1, 0.1, 0.5),
          });
        }
      } else if (ann.type === "date") {
        const dateValue = ann.value || "";
        if (dateValue) {
          const dateSize = scriptFont ? 14 : 9;
          page.drawText(dateValue, {
            x: ann.xPos * width,
            y: (1 - ann.yPos) * height,
            size: dateSize,
            font: scriptFont || font,
            color: rgb(0.05, 0.05, 0.3),
          });
        }
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
