import { useEffect, useRef, useState, useCallback } from "react";
import { FileText, PenTool, CheckCircle2, Loader2 } from "lucide-react";

interface PlacedField {
  id: number;
  type: "initial" | "signature" | "date";
  pageNumber: number;
  xPos: number;
  yPos: number;
  width: number | null;
  height: number | null;
}

interface LockedPageViewProps {
  pdfUrl: string;
  pageNumber: number;
  fields: PlacedField[];
  signerFullName: string;
  initialPlaced: boolean;
  signaturePlaced: boolean;
  showFixedBottomSignaturePlaceholder: boolean;
  onClickInitial?: () => void;
  onClickSignature?: () => void;
  initialPending?: boolean;
  signaturePending?: boolean;
}

let pdfjsLibPromise: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("pdfjs-dist").then(async (lib) => {
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      return lib;
    });
  }
  return pdfjsLibPromise;
}

const docCache = new Map<string, Promise<any>>();
function loadDocument(pdfUrl: string) {
  if (!docCache.has(pdfUrl)) {
    const promise = loadPdfjs().then((lib) =>
      lib.getDocument({ url: pdfUrl, withCredentials: false }).promise,
    );
    docCache.set(pdfUrl, promise);
  }
  return docCache.get(pdfUrl)!;
}

const signerInitialsOf = (fullName: string) =>
  fullName.split(" ").map(n => n[0]).join("").toUpperCase();

export function LockedPageView({
  pdfUrl,
  pageNumber,
  fields,
  signerFullName,
  initialPlaced,
  signaturePlaced,
  showFixedBottomSignaturePlaceholder,
  onClickInitial,
  onClickSignature,
  initialPending,
  signaturePending,
}: LockedPageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(true);
  const [renderedSize, setRenderedSize] = useState<{ w: number; h: number; pageWidthPt: number; pageHeightPt: number } | null>(null);

  const renderPage = useCallback(async () => {
    setRenderError(null);
    setIsRendering(true);
    try {
      const doc = await loadDocument(pdfUrl);
      if (pageNumber < 1 || pageNumber > doc.numPages) {
        throw new Error(`Page ${pageNumber} out of range`);
      }
      const page = await doc.getPage(pageNumber);

      const containerWidth = containerRef.current?.clientWidth ?? 800;
      const maxHeight = Math.min(window.innerHeight * 0.78, 1100);

      const baseViewport = page.getViewport({ scale: 1 });
      const scaleByWidth = containerWidth / baseViewport.width;
      const scaleByHeight = maxHeight / baseViewport.height;
      const cssScale = Math.min(scaleByWidth, scaleByHeight);
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
      const viewport = page.getViewport({ scale: cssScale * dpr });

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

      await page.render({ canvasContext: ctx, viewport, canvas }).promise;

      setRenderedSize({
        w: Math.floor(viewport.width / dpr),
        h: Math.floor(viewport.height / dpr),
        pageWidthPt: baseViewport.width,
        pageHeightPt: baseViewport.height,
      });
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRendering(false);
    }
  }, [pdfUrl, pageNumber]);

  useEffect(() => {
    renderPage();
  }, [renderPage]);

  useEffect(() => {
    const onResize = () => renderPage();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [renderPage]);

  const initialField = fields.find(f => f.type === "initial");
  const signatureField = fields.find(f => f.type === "signature");
  const initials = signerInitialsOf(signerFullName);

  return (
    <div
      ref={containerRef}
      className="w-full flex flex-col items-center bg-muted rounded-md overflow-hidden"
      data-testid={`locked-page-view-${pageNumber}`}
    >
      <div
        className="relative inline-block bg-white shadow-md"
        style={renderedSize ? { width: renderedSize.w, height: renderedSize.h } : undefined}
      >
        <canvas
          ref={canvasRef}
          className="block"
          data-testid={`locked-page-canvas-${pageNumber}`}
        />

        {isRendering && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 backdrop-blur-sm">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {renderError && (
          <div className="absolute inset-0 flex items-center justify-center bg-white p-6">
            <div className="text-center space-y-2">
              <FileText className="h-12 w-12 text-muted-foreground/40 mx-auto" />
              <p className="text-sm text-destructive">Could not render page {pageNumber}</p>
              <p className="text-xs text-muted-foreground">{renderError}</p>
            </div>
          </div>
        )}

        {renderedSize && initialField && (
          <FieldOverlay
            field={initialField}
            renderedSize={renderedSize}
            placed={initialPlaced}
            kind="initial"
            label={`Initial [${initials}]`}
            placedValue={initials}
            onClick={onClickInitial}
            pending={!!initialPending}
            testId={`field-initial-page-${pageNumber}`}
            signerFullName={signerFullName}
          />
        )}

        {renderedSize && signatureField && (
          <FieldOverlay
            field={signatureField}
            renderedSize={renderedSize}
            placed={signaturePlaced}
            kind="signature"
            label="Sign here"
            placedValue={signerFullName}
            onClick={onClickSignature}
            pending={!!signaturePending}
            testId={`field-signature-page-${pageNumber}`}
            signerFullName={signerFullName}
          />
        )}

        {renderedSize && showFixedBottomSignaturePlaceholder && (
          <FixedBottomSignatureOverlay
            renderedSize={renderedSize}
            placed={signaturePlaced}
            signerFullName={signerFullName}
            onClick={onClickSignature}
            pending={!!signaturePending}
          />
        )}
      </div>
    </div>
  );
}

function FieldOverlay({
  field,
  renderedSize,
  placed,
  kind,
  label,
  placedValue,
  onClick,
  pending,
  testId,
  signerFullName,
}: {
  field: PlacedField;
  renderedSize: { w: number; h: number };
  placed: boolean;
  kind: "initial" | "signature";
  label: string;
  placedValue: string;
  onClick?: () => void;
  pending: boolean;
  testId: string;
  signerFullName: string;
}) {
  const left = field.xPos * renderedSize.w;
  const top = field.yPos * renderedSize.h;
  const width = (field.width ?? (kind === "signature" ? 0.25 : 0.08)) * renderedSize.w;
  const height = (field.height ?? (kind === "signature" ? 0.06 : 0.04)) * renderedSize.h;

  if (placed) {
    return (
      <div
        className="absolute pointer-events-none flex items-center justify-center bg-blue-50/70 dark:bg-blue-950/40 border border-blue-300 dark:border-blue-800 rounded-sm"
        style={{ left, top, width, height }}
        data-testid={`${testId}-placed`}
      >
        {kind === "signature" ? (
          <span
            className="text-blue-800 dark:text-blue-200 italic truncate px-1"
            style={{ fontFamily: "'Dancing Script', cursive", fontSize: Math.max(12, height * 0.6) }}
          >
            {signerFullName}
          </span>
        ) : (
          <span className="font-semibold text-blue-800 dark:text-blue-200 flex items-center gap-1 px-1">
            <CheckCircle2 className="h-3 w-3" />
            <span className="text-xs">{placedValue}</span>
          </span>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="absolute flex items-center justify-center border-2 border-dashed border-orange-500 bg-orange-50/80 dark:bg-orange-950/40 hover:bg-orange-100 dark:hover:bg-orange-900/60 text-orange-700 dark:text-orange-300 rounded-sm shadow-sm transition-colors cursor-pointer disabled:cursor-wait animate-pulse"
      style={{ left, top, width, height }}
      data-testid={`${testId}-placeholder`}
    >
      <PenTool className="h-3.5 w-3.5 mr-1" />
      <span className="text-xs font-semibold uppercase tracking-wide truncate px-1">
        {pending ? "Saving…" : label}
      </span>
    </button>
  );
}

function FixedBottomSignatureOverlay({
  renderedSize,
  placed,
  signerFullName,
  onClick,
  pending,
}: {
  renderedSize: { w: number; h: number; pageWidthPt: number; pageHeightPt: number };
  placed: boolean;
  signerFullName: string;
  onClick?: () => void;
  pending: boolean;
}) {
  // Mirror PdfService.stampSignedPdf() fixed_bottom_centre geometry exactly:
  //   boxWidth = 260pt (fallback when annotation.width is unset)
  //   boxHeight = scriptLineHeight(≈32) + padding(8) + metaLineHeight(12)*4 + padding(8) ≈ 96pt
  //   boxX     = (pageWidth - boxWidth) / 2
  //   boxY     = 10mm padding from page bottom (≈ 28.35pt)
  // We project these PDF-point values into rendered CSS pixels via pageWidthPt/pageHeightPt.
  const BOX_WIDTH_PT = 260;
  const BOX_HEIGHT_PT = 96;
  const BOTTOM_PADDING_PT = 28.35;
  const pxPerPtX = renderedSize.w / renderedSize.pageWidthPt;
  const pxPerPtY = renderedSize.h / renderedSize.pageHeightPt;
  const width = BOX_WIDTH_PT * pxPerPtX;
  const height = BOX_HEIGHT_PT * pxPerPtY;
  const left = (renderedSize.pageWidthPt - BOX_WIDTH_PT) / 2 * pxPerPtX;
  const top = renderedSize.h - height - BOTTOM_PADDING_PT * pxPerPtY;

  if (placed) {
    return (
      <div
        className="absolute pointer-events-none flex items-center justify-center bg-blue-50/70 dark:bg-blue-950/40 border border-blue-300 dark:border-blue-800 rounded-sm"
        style={{ left, top, width, height }}
        data-testid="field-signature-fixed-bottom-placed"
      >
        <span
          className="text-blue-800 dark:text-blue-200 italic truncate px-1"
          style={{ fontFamily: "'Dancing Script', cursive", fontSize: Math.max(14, height * 0.5) }}
        >
          {signerFullName}
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="absolute flex flex-col items-center justify-center border-2 border-dashed border-orange-500 bg-orange-50/80 dark:bg-orange-950/40 hover:bg-orange-100 dark:hover:bg-orange-900/60 text-orange-700 dark:text-orange-300 rounded-sm shadow-sm transition-colors cursor-pointer disabled:cursor-wait animate-pulse"
      style={{ left, top, width, height }}
      data-testid="field-signature-fixed-bottom-placeholder"
    >
      <span className="text-[10px] font-bold uppercase tracking-wide">
        {pending ? "Signing…" : "Sign here"}
      </span>
      <span
        className="italic truncate max-w-full"
        style={{ fontFamily: "'Dancing Script', cursive", fontSize: Math.max(12, height * 0.4) }}
      >
        {signerFullName}
      </span>
    </button>
  );
}
