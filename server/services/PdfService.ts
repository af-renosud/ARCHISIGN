import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { generateAuthenticationId } from "./SecurityService";

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

export interface CertificateSigner {
  id: number;
  fullName: string;
  email: string;
  signedAt: Date | string | null;
  sentAt?: Date | string | null;
  lastViewedAt?: Date | string | null;
  otpIssuedAt?: Date | string | null;
  otpVerifiedAt?: Date | string | null;
  signerIpAddress?: string | null;
  signerUserAgent?: string | null;
}

export interface CertificateAuditEvent {
  eventType: string;
  actorEmail?: string | null;
  ipAddress?: string | null;
  timestamp: Date | string;
}

export interface EnvelopeCertificateContext {
  envelopeId: number;
  subject: string;
  externalRef?: string | null;
  status: string;
  origin?: string | null;
  firmName: string;
  firmEmail?: string | null;
  totalDocumentPages: number;
  signatureCount: number;
  initialCount: number;
  signers: CertificateSigner[];
  auditEvents: CertificateAuditEvent[];
  envelopeCreatedAt: Date | string;
}

const CERT_MARKER_PREFIX = "archisign-cert-v1:";

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

function formatTs(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toISOString().replace("T", " ").replace(/\..*$/, " UTC");
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.substring(0, n - 1) + "…";
}

export async function stampSignedPdf(
  pdfBuffer: Buffer,
  signersWithAnnotations: SignerWithAnnotations[],
  envelopeId: number,
  signaturePlacementMode: SignaturePlacementMode = "fixed_bottom_centre",
  certificateContext?: EnvelopeCertificateContext,
): Promise<{ signedPdfBytes: Uint8Array; documentHash: string }> {
  const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");
  const fontkit = (await import("@pdf-lib/fontkit")).default;

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  pdfDoc.registerFontkit(fontkit);

  // Idempotency: if the input already has a previously-appended certificate,
  // strip the trailing cert pages before re-rendering so callers can re-stamp
  // without compounding certificates.
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
        const authId = generateAuthenticationId(signer.id, envelopeId, signer.signedAt);

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
          boxX = ann.xPos * width;
          boxY = (1 - ann.yPos) * height - boxHeight;
        } else {
          const MM_TO_PT = 2.83465;
          const bottomPaddingPt = 10 * MM_TO_PT;
          boxX = (width - boxWidth) / 2;
          boxY = bottomPaddingPt;
        }
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

        const boxWidthPt =
          ann.width != null ? ann.width * width : (ann.type === "initial" ? 0.08 * width : 0.15 * width);
        const boxHeightPt =
          ann.height != null ? ann.height * height : (ann.type === "initial" ? 0.04 * height : 0.03 * height);
        const boxLeftPt = ann.xPos * width;
        const boxBottomPt = (1 - ann.yPos) * height - boxHeightPt;

        const chosenFont = scriptFont || font;
        const maxByHeight = boxHeightPt * 0.8;
        const maxByWidth = (boxWidthPt * 0.95) / Math.max(1, chosenFont.widthOfTextAtSize(text, 1));
        const fontSize = Math.max(6, Math.min(48, maxByHeight, maxByWidth));
        const textWidth = chosenFont.widthOfTextAtSize(text, fontSize);
        const textHeight = chosenFont.heightAtSize(fontSize);
        const textX = boxLeftPt + (boxWidthPt - textWidth) / 2;
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

  // Hash the signed *body* before appending the certificate so the hash
  // printed on the certificate identifies the signed document content, not
  // the certificate-augmented file.
  const signedBodyBytes = await pdfDoc.save();
  const documentHash = createHash("sha256")
    .update(Buffer.from(signedBodyBytes))
    .digest("hex");

  // Re-load and append the certificate so the embedded hash refers to a
  // saveable, complete signed body.
  const finalDoc = await PDFDocument.load(signedBodyBytes);
  finalDoc.registerFontkit(fontkit);
  const finalFont = await finalDoc.embedFont(StandardFonts.Helvetica);
  const finalFontBold = await finalDoc.embedFont(StandardFonts.HelveticaBold);

  let certificatePagesAdded = 0;
  if (certificateContext) {
    certificatePagesAdded = await renderCertificatePages(finalDoc, {
      ...certificateContext,
      envelopeId,
    }, finalFont, finalFontBold, documentHash);

    // Embed marker so a later re-stamp can detect & strip our pages.
    try {
      finalDoc.setKeywords([
        `${CERT_MARKER_PREFIX}${certificatePagesAdded}`,
        `envelope:${envelopeId}`,
        `hash:${documentHash}`,
      ]);
    } catch {
      // Non-fatal — keywords are best-effort idempotency aid.
    }
  }

  const signedPdfBytes = await finalDoc.save();
  return { signedPdfBytes, documentHash };
}

async function renderCertificatePages(
  pdfDoc: any,
  ctx: EnvelopeCertificateContext,
  font: any,
  fontBold: any,
  documentHash: string,
): Promise<number> {
  const { rgb } = await import("pdf-lib");

  const PAGE_WIDTH = 595.28;   // A4 portrait, points
  const PAGE_HEIGHT = 841.89;
  const MARGIN_X = 50;
  const MARGIN_TOP = 50;
  const MARGIN_BOTTOM = 60;
  const LINE = 12;
  const SMALL = 9;
  const BODY = 10;

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let pagesAdded = 1;
  let y = PAGE_HEIGHT - MARGIN_TOP;

  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN_BOTTOM) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      pagesAdded += 1;
      y = PAGE_HEIGHT - MARGIN_TOP;
      drawPageFooter();
    }
  };

  const drawPageFooter = () => {
    page.drawText(
      `Envelope ${ctx.envelopeId} · ${ctx.firmName} · Certificate of Completion · doc-hash ${truncate(documentHash, 24)}`,
      { x: MARGIN_X, y: MARGIN_BOTTOM - 25, size: 7, font, color: rgb(0.4, 0.4, 0.4) },
    );
  };

  const drawText = (
    text: string,
    opts: { size?: number; bold?: boolean; color?: [number, number, number]; x?: number } = {},
  ) => {
    const size = opts.size ?? BODY;
    page.drawText(text, {
      x: opts.x ?? MARGIN_X,
      y,
      size,
      font: opts.bold ? fontBold : font,
      color: rgb(...(opts.color ?? [0.1, 0.1, 0.1])),
    });
  };

  const drawHr = () => {
    page.drawLine({
      start: { x: MARGIN_X, y: y + 2 },
      end: { x: PAGE_WIDTH - MARGIN_X, y: y + 2 },
      thickness: 0.5,
      color: rgb(0.7, 0.7, 0.7),
    });
  };

  // Title
  drawText("Certificate of Completion", { size: 18, bold: true });
  y -= 22;
  drawText(`Issued by ${ctx.firmName}`, { size: SMALL, color: [0.4, 0.4, 0.4] });
  y -= 18;
  drawHr();
  y -= 14;

  // Header summary — two columns
  const colX2 = PAGE_WIDTH / 2 + 10;
  const header: Array<[string, string, string, string]> = [
    [`Envelope ID:`, String(ctx.envelopeId), `Status:`, ctx.status],
    [`Subject:`, truncate(ctx.subject || "", 60), `Origin:`, ctx.origin || "local"],
    [`External Ref:`, ctx.externalRef || "—", `Originator:`, ctx.firmEmail || ctx.firmName],
    [`Document Pages:`, String(ctx.totalDocumentPages), `Signatures:`, String(ctx.signatureCount)],
    [`Initials:`, String(ctx.initialCount), `Created:`, formatTs(ctx.envelopeCreatedAt)],
  ];
  for (const [l1, v1, l2, v2] of header) {
    ensureSpace(LINE);
    drawText(l1, { size: SMALL, bold: true });
    page.drawText(v1, { x: MARGIN_X + 90, y, size: SMALL, font, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(l2, { x: colX2, y, size: SMALL, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(v2, { x: colX2 + 90, y, size: SMALL, font, color: rgb(0.1, 0.1, 0.1) });
    y -= LINE;
  }

  y -= 8;
  drawHr();
  y -= 14;

  // Per-signer blocks
  drawText("Signer Events", { size: 12, bold: true });
  y -= 16;
  for (const s of ctx.signers) {
    const authId = s.signedAt
      ? generateAuthenticationId(s.id, ctx.envelopeId, s.signedAt)
      : "—";

    const lines: Array<[string, string]> = [
      ["Name", s.fullName],
      ["Email", s.email],
      ["Security level", "Email + token, OTP verified"],
      ["Sent", formatTs(s.sentAt)],
      ["Viewed", formatTs(s.lastViewedAt)],
      ["OTP issued", formatTs(s.otpIssuedAt)],
      ["OTP verified", formatTs(s.otpVerifiedAt)],
      ["Signed", formatTs(s.signedAt)],
      ["IP address", s.signerIpAddress || "—"],
      ["User agent", truncate(s.signerUserAgent || "—", 80)],
      ["Authentication ID", authId],
    ];

    ensureSpace(lines.length * LINE + 12);
    drawText(s.fullName, { size: 11, bold: true });
    y -= LINE + 2;
    for (const [k, v] of lines) {
      ensureSpace(LINE);
      drawText(k, { size: SMALL, bold: true });
      page.drawText(v, { x: MARGIN_X + 110, y, size: SMALL, font, color: rgb(0.1, 0.1, 0.1) });
      y -= LINE;
    }
    y -= 6;
    drawHr();
    y -= 10;
  }

  // Envelope timeline from audit events
  drawText("Envelope Summary Events", { size: 12, bold: true });
  y -= 16;
  ensureSpace(LINE);
  drawText("Event", { size: SMALL, bold: true });
  page.drawText("Actor", { x: MARGIN_X + 180, y, size: SMALL, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
  page.drawText("Timestamp", { x: MARGIN_X + 340, y, size: SMALL, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
  y -= LINE;
  const eventsAsc = [...ctx.auditEvents].sort((a, b) => {
    const da = new Date(a.timestamp).getTime();
    const db = new Date(b.timestamp).getTime();
    return da - db;
  });
  for (const ev of eventsAsc) {
    ensureSpace(LINE);
    page.drawText(truncate(ev.eventType, 32), { x: MARGIN_X, y, size: SMALL, font, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(truncate(ev.actorEmail || "—", 28), { x: MARGIN_X + 180, y, size: SMALL, font, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(formatTs(ev.timestamp), { x: MARGIN_X + 340, y, size: SMALL, font, color: rgb(0.1, 0.1, 0.1) });
    y -= LINE;
  }

  y -= 12;
  ensureSpace(40);
  drawHr();
  y -= 14;
  drawText("Document Integrity", { size: 11, bold: true });
  y -= 14;
  drawText(`SHA-256 (signed body): ${documentHash}`, { size: SMALL });
  y -= LINE;
  drawText(
    "This certificate was generated by Archisign and is bound to the signed document by the hash above. Any modification to the signed body invalidates this hash.",
    { size: SMALL, color: [0.35, 0.35, 0.35] },
  );

  drawPageFooter();
  return pagesAdded;
}
