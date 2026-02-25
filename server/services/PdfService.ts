import { createHash } from "crypto";

interface SignerData {
  id: number;
  fullName: string;
  signedAt: Date | string | null;
}

interface AnnotationData {
  pageNumber: number;
  xPos: number;
  yPos: number;
  type: "initial" | "signature" | "date";
  value: string | null;
}

interface SignerWithAnnotations {
  signer: SignerData;
  annotations: AnnotationData[];
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

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

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

        const boxWidth = 220;
        const boxHeight = 68;
        const margin = 10;
        let boxX = ann.xPos * width - boxWidth / 2;
        let boxY = (1 - ann.yPos) * height - boxHeight / 2;
        boxX = Math.max(margin, Math.min(boxX, width - boxWidth - margin));
        boxY = Math.max(margin, Math.min(boxY, height - boxHeight - margin));
        const padding = 8;
        const lineHeight = 14;
        const labelSize = 8;
        const titleSize = 9;

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
        let textY = boxY + boxHeight - padding - titleSize;

        page.drawText("DIGITAL ENVELOPE", {
          x: textX,
          y: textY,
          size: titleSize,
          font: fontBold,
          color: rgb(0, 0, 0.7),
        });
        textY -= lineHeight;

        page.drawText(`SIGNED BY: ${signer.fullName}`, {
          x: textX,
          y: textY,
          size: labelSize,
          font: fontBold,
          color: rgb(0, 0, 0.7),
        });
        textY -= lineHeight;

        page.drawText(`DATE: ${dateStr}`, {
          x: textX,
          y: textY,
          size: labelSize,
          font: fontBold,
          color: rgb(0, 0, 0.7),
        });
        textY -= lineHeight;

        page.drawText(`AUTHENTICATION: ${authId}`, {
          x: textX,
          y: textY,
          size: labelSize,
          font: fontBold,
          color: rgb(0, 0, 0.7),
        });
      } else {
        page.drawText(`[${ann.value}]`, {
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
