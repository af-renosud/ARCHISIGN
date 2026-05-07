import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  PenTool,
  Type,
  Calendar,
  Trash2,
  GripVertical,
  Save,
  Lock,
  Move,
  Check,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Unlock,
} from "lucide-react";
import type { Envelope, Signer, Annotation } from "@shared/schema";

type FieldType = "signature" | "initial" | "date";
type SignaturePlacementMode = "fixed_bottom_centre" | "admin_placed";
type EditorMode = "guided" | "free";

interface PlacedField {
  id?: number;
  type: FieldType;
  signerId: number;
  pageNumber: number;
  xPos: number;
  yPos: number;
  width: number;
  height: number;
  isNew?: boolean;
}

const FIELD_DEFAULTS: Record<FieldType, { width: number; height: number; label: string }> = {
  signature: { width: 0.25, height: 0.08, label: "Signature" },
  initial: { width: 0.08, height: 0.04, label: "Initial" },
  date: { width: 0.15, height: 0.03, label: "Date" },
};

const FIELD_COLORS: Record<FieldType, string> = {
  signature: "border-red-500 bg-red-50 dark:bg-red-950/30",
  initial: "border-blue-500 bg-blue-50 dark:bg-blue-950/30",
  date: "border-green-500 bg-green-50 dark:bg-green-950/30",
};

const FIELD_DOT_COLORS: Record<FieldType, string> = {
  signature: "bg-red-500",
  initial: "bg-blue-500",
  date: "bg-green-500",
};

const FIELD_ICONS: Record<FieldType, typeof PenTool> = {
  signature: PenTool,
  initial: Type,
  date: Calendar,
};

const CLICK_THRESHOLD_PX = 4;

export default function EnvelopeFieldEditor() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [fields, setFields] = useState<PlacedField[]>([]);
  const [selectedSignerId, setSelectedSignerId] = useState<number | null>(null);
  const [placementMode, setPlacementMode] = useState<SignaturePlacementMode>("fixed_bottom_centre");
  const [editorMode, setEditorMode] = useState<EditorMode>("guided");
  const [maxUnlockedPage, setMaxUnlockedPage] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedFieldIndex, setSelectedFieldIndex] = useState<number | null>(null);
  const [draggingField, setDraggingField] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
  const [dragMoved, setDragMoved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [confirmPageOpen, setConfirmPageOpen] = useState<number | null>(null);
  const [savePromptOpen, setSavePromptOpen] = useState<{
    missingSignature: string[];
    pagesMissingInitial: { signer: string; pages: number[] }[];
  } | null>(null);
  const [expandedSigners, setExpandedSigners] = useState<Set<number>>(new Set());

  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const overlayRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const sidebarFieldRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const { data: envelope, isLoading } = useQuery<Envelope & { signers: Signer[] }>({
    queryKey: ["/api/envelopes", id],
    queryFn: async () => {
      const res = await fetch(`/api/envelopes/${id}`);
      if (!res.ok) throw new Error("Failed to load envelope");
      return res.json();
    },
    enabled: !!id,
  });

  const { data: existingAnnotations } = useQuery<Annotation[]>({
    queryKey: ["/api/envelopes", id, "annotations"],
    queryFn: async () => {
      const res = await fetch(`/api/envelopes/${id}/annotations`);
      if (!res.ok) throw new Error("Failed to load annotations");
      return res.json();
    },
    enabled: !!id,
  });

  const totalPages = envelope?.totalPages ?? 1;

  useEffect(() => {
    if (existingAnnotations && !loaded) {
      const placedOnes = existingAnnotations
        .filter((a) => a.placed)
        .map((a) => ({
          id: a.id,
          type: a.type as FieldType,
          signerId: a.signerId,
          pageNumber: a.pageNumber,
          xPos: a.xPos,
          yPos: a.yPos,
          width: a.width ?? FIELD_DEFAULTS[a.type as FieldType].width,
          height: a.height ?? FIELD_DEFAULTS[a.type as FieldType].height,
        }));
      setFields(placedOnes);
      setLoaded(true);
      // If reopening an envelope with prior placements, unlock everything they've already touched.
      if (placedOnes.length > 0) {
        const maxPlaced = Math.max(...placedOnes.map((f) => f.pageNumber));
        setMaxUnlockedPage(maxPlaced);
      }
    }
  }, [existingAnnotations, loaded]);

  useEffect(() => {
    if (envelope?.signers?.length && !selectedSignerId) {
      setSelectedSignerId(envelope.signers[0].id);
      setExpandedSigners(new Set([envelope.signers[0].id]));
    }
  }, [envelope, selectedSignerId]);

  useEffect(() => {
    if (envelope?.signaturePlacementMode) {
      setPlacementMode(envelope.signaturePlacementMode as SignaturePlacementMode);
    }
  }, [envelope?.signaturePlacementMode]);

  const placementModeMutation = useMutation({
    mutationFn: async (vars: { mode: SignaturePlacementMode; previous: SignaturePlacementMode }) => {
      await apiRequest("PATCH", `/api/envelopes/${id}`, { signaturePlacementMode: vars.mode });
      return vars;
    },
    onSuccess: (vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/envelopes", id] });
      toast({
        title: "Placement updated",
        description:
          vars.mode === "admin_placed"
            ? "Signature will use the position you place on the document."
            : "Signature will be locked to the bottom-centre of the last page.",
      });
    },
    onError: (err: Error, vars) => {
      setPlacementMode(vars.previous);
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const persistFields = async () => {
    const toDelete = (existingAnnotations || [])
      .filter((a) => a.placed)
      .filter((a) => !fields.some((f) => f.id === a.id));
    for (const ann of toDelete) {
      await apiRequest("DELETE", `/api/envelopes/${id}/annotations/${ann.id}`);
    }
    for (const field of fields) {
      if (field.id && !field.isNew) {
        await apiRequest("PUT", `/api/envelopes/${id}/annotations/${field.id}`, {
          xPos: field.xPos,
          yPos: field.yPos,
          width: field.width,
          height: field.height,
          pageNumber: field.pageNumber,
        });
      } else {
        await apiRequest("POST", `/api/envelopes/${id}/annotations`, {
          signerId: field.signerId,
          pageNumber: field.pageNumber,
          xPos: field.xPos,
          yPos: field.yPos,
          width: field.width,
          height: field.height,
          type: field.type,
        });
      }
    }
  };

  const saveMutation = useMutation({
    mutationFn: persistFields,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/envelopes", id, "annotations"] });
      setLoaded(false);
      toast({ title: "Fields saved", description: "Annotation placements have been saved." });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const signerName = useCallback(
    (signerId: number) =>
      envelope?.signers.find((s) => s.id === signerId)?.fullName ?? "Unknown",
    [envelope]
  );

  const fieldsWithIndex = useMemo(
    () => fields.map((f, i) => ({ ...f, index: i })),
    [fields]
  );

  const fieldsOnPage = useCallback(
    (page: number) => fieldsWithIndex.filter((f) => f.pageNumber === page),
    [fieldsWithIndex]
  );

  const currentPageFields = useMemo(
    () => fieldsOnPage(currentPage),
    [fieldsOnPage, currentPage]
  );

  // Per-page summary for the rail (signer-aware via selectedSignerId).
  // A page is "complete" for the selected signer when that signer has every
  // field they need on this page: at minimum one initial, plus a signature
  // on the page that bears the signature box when placement is admin_placed.
  const pageSummary = useCallback(
    (page: number) => {
      const onPage = fieldsOnPage(page);
      const counts: Record<FieldType, number> = { signature: 0, initial: 0, date: 0 };
      for (const f of onPage) counts[f.type] += 1;

      let completeForSelected = false;
      if (selectedSignerId != null) {
        const hasInitial = onPage.some(
          (f) => f.type === "initial" && f.signerId === selectedSignerId
        );
        const hasSignature = onPage.some(
          (f) => f.type === "signature" && f.signerId === selectedSignerId
        );
        // Pages where the signer needs a signature placed:
        //  - admin_placed mode: any page they've put a signature box on must keep it
        //  - fixed_bottom_centre: signature is auto-stamped on the last page only
        const signerPlacedSignatureHere =
          placementMode === "admin_placed" &&
          fields.some(
            (f) =>
              f.type === "signature" &&
              f.signerId === selectedSignerId &&
              f.pageNumber === page
          );
        const signatureRequiredHere = signerPlacedSignatureHere;
        completeForSelected = hasInitial && (!signatureRequiredHere || hasSignature);
      }

      return { counts, completeForSelected, total: onPage.length };
    },
    [fieldsOnPage, selectedSignerId, placementMode, fields]
  );

  const visiblePages = useMemo(() => {
    if (editorMode === "free") return Array.from({ length: totalPages }, (_, i) => i + 1);
    return Array.from({ length: Math.min(maxUnlockedPage, totalPages) }, (_, i) => i + 1);
  }, [editorMode, totalPages, maxUnlockedPage]);

  // Scroll-driven currentPage sync in both Guided and Free modes.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        let topMost: { page: number; ratio: number } | null = null;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const page = Number((e.target as HTMLElement).dataset.page);
          if (!page) continue;
          if (!topMost || e.intersectionRatio > topMost.ratio) {
            topMost = { page, ratio: e.intersectionRatio };
          }
        }
        if (topMost) setCurrentPage(topMost.page);
      },
      {
        root: canvasScrollRef.current,
        threshold: [0.3, 0.5, 0.7],
      }
    );
    pageRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [visiblePages.length]);

  const scrollToPage = useCallback((page: number) => {
    const el = pageRefs.current.get(page);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    setCurrentPage(page);
  }, []);

  const goToRailPage = useCallback(
    (page: number) => {
      if (editorMode === "guided" && page > maxUnlockedPage) {
        // Open the confirm dialog for the *current* page so admin must complete it first.
        setConfirmPageOpen(maxUnlockedPage);
        return;
      }
      scrollToPage(page);
    },
    [editorMode, maxUnlockedPage, scrollToPage]
  );

  const confirmCurrentPageComplete = () => {
    const next = Math.min(totalPages, (confirmPageOpen ?? maxUnlockedPage) + 1);
    setMaxUnlockedPage((prev) => Math.max(prev, next));
    setConfirmPageOpen(null);
    // After unlocking, scroll to the new page once it has rendered.
    setTimeout(() => scrollToPage(next), 50);
  };

  const addField = useCallback(
    (type: FieldType) => {
      if (!selectedSignerId) return;
      if (editorMode === "guided" && currentPage > maxUnlockedPage) {
        toast({
          title: "Page locked",
          description: "Confirm the current page is complete before adding fields to a later page.",
          variant: "destructive",
        });
        return;
      }
      const defaults = FIELD_DEFAULTS[type];
      setFields((prev) => {
        const next = [
          ...prev,
          {
            type,
            signerId: selectedSignerId,
            pageNumber: currentPage,
            xPos: 0.3 + Math.random() * 0.2,
            yPos: 0.3 + Math.random() * 0.2,
            width: defaults.width,
            height: defaults.height,
            isNew: true,
          },
        ];
        // Select the just-added field so it pulses on the canvas.
        setSelectedFieldIndex(next.length - 1);
        return next;
      });
    },
    [selectedSignerId, currentPage, editorMode, maxUnlockedPage, toast]
  );

  const removeField = useCallback((index: number) => {
    setFields((prev) => prev.filter((_, i) => i !== index));
    setSelectedFieldIndex((cur) => {
      if (cur === null) return cur;
      if (cur === index) return null;
      if (cur > index) return cur - 1;
      return cur;
    });
  }, []);

  // Click vs drag distinction.
  const handleMouseDown = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.preventDefault();
      e.stopPropagation();
      const field = fields[index];
      const overlay = overlayRefs.current.get(field.pageNumber);
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      const fieldXPx = field.xPos * rect.width;
      const fieldYPx = field.yPos * rect.height;
      setDragOffset({
        x: e.clientX - rect.left - fieldXPx,
        y: e.clientY - rect.top - fieldYPx,
      });
      setDragStartPos({ x: e.clientX, y: e.clientY });
      setDragMoved(false);
      setDraggingField(index);
    },
    [fields]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent, page: number) => {
      if (draggingField === null) return;
      const overlay = overlayRefs.current.get(page);
      if (!overlay) return;
      if (dragStartPos) {
        const dx = Math.abs(e.clientX - dragStartPos.x);
        const dy = Math.abs(e.clientY - dragStartPos.y);
        if (!dragMoved && (dx > CLICK_THRESHOLD_PX || dy > CLICK_THRESHOLD_PX)) {
          setDragMoved(true);
        }
        if (dx <= CLICK_THRESHOLD_PX && dy <= CLICK_THRESHOLD_PX) return;
      }
      const rect = overlay.getBoundingClientRect();
      const newX = (e.clientX - rect.left - dragOffset.x) / rect.width;
      const newY = (e.clientY - rect.top - dragOffset.y) / rect.height;
      setFields((prev) =>
        prev.map((f, i) =>
          i === draggingField
            ? { ...f, xPos: Math.max(0, Math.min(1, newX)), yPos: Math.max(0, Math.min(1, newY)) }
            : f
        )
      );
    },
    [draggingField, dragOffset, dragStartPos, dragMoved]
  );

  const handleMouseUp = useCallback(() => {
    if (draggingField !== null && !dragMoved) {
      // Treat as a click — select.
      setSelectedFieldIndex(draggingField);
      // Scroll matching sidebar row into view if rendered.
      requestAnimationFrame(() => {
        const row = sidebarFieldRefs.current.get(draggingField);
        if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
    setDraggingField(null);
    setDragStartPos(null);
    setDragMoved(false);
  }, [draggingField, dragMoved]);

  // Keyboard: Delete / Backspace removes selected field when not typing in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedFieldIndex !== null) {
        e.preventDefault();
        removeField(selectedFieldIndex);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedFieldIndex, removeField]);

  const handleCanvasBgClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) setSelectedFieldIndex(null);
  };

  const onSidebarFieldClick = (index: number, page: number) => {
    setSelectedFieldIndex(index);
    if (page !== currentPage) scrollToPage(page);
  };

  const handleSaveClick = () => {
    if (!envelope) {
      saveMutation.mutate();
      return;
    }
    const missingSignature =
      placementMode === "admin_placed"
        ? envelope.signers
            .filter((s) => !fields.some((f) => f.signerId === s.id && f.type === "signature"))
            .map((s) => s.fullName)
        : [];
    const pagesMissingInitial: { signer: string; pages: number[] }[] = [];
    for (const s of envelope.signers) {
      const pages: number[] = [];
      for (let p = 1; p <= totalPages; p++) {
        const hasInitial = fields.some(
          (f) => f.signerId === s.id && f.type === "initial" && f.pageNumber === p
        );
        if (!hasInitial) pages.push(p);
      }
      if (pages.length > 0) pagesMissingInitial.push({ signer: s.fullName, pages });
    }
    if (missingSignature.length === 0 && pagesMissingInitial.length === 0) {
      saveMutation.mutate();
      return;
    }
    setSavePromptOpen({ missingSignature, pagesMissingInitial });
  };

  const toggleSignerExpanded = (signerId: number) => {
    setExpandedSigners((prev) => {
      const next = new Set(prev);
      if (next.has(signerId)) next.delete(signerId);
      else next.add(signerId);
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="p-4 space-y-4 h-full overflow-y-auto">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
  }

  if (!envelope) {
    return (
      <div className="p-4">
        <p className="text-muted-foreground">Envelope not found.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="border-b bg-background px-4 py-3 flex items-center justify-between gap-3 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" onClick={() => navigate(`/envelopes/${id}`)} data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold truncate" data-testid="text-editor-title">
              Place Fields — {envelope.subject}
            </h1>
            <p className="text-xs text-muted-foreground">
              Page {currentPage} of {totalPages}
              {selectedSignerId != null && ` — ${signerName(selectedSignerId)}`}
              {(() => {
                const c = pageSummary(currentPage).counts;
                return ` — ${c.signature} sig, ${c.initial} init, ${c.date} date`;
              })()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Badge
            variant={editorMode === "guided" ? "default" : "secondary"}
            className="hidden sm:inline-flex"
            data-testid="badge-editor-mode"
          >
            {editorMode === "guided" ? "Guided" : "Free"} mode
          </Badge>
          <Button
            onClick={handleSaveClick}
            disabled={saveMutation.isPending}
            data-testid="button-save-fields"
          >
            <Save className="h-4 w-4 mr-2" />
            {saveMutation.isPending ? "Saving..." : "Save Fields"}
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-64 border-r bg-muted/30 p-4 flex flex-col gap-4 overflow-y-auto flex-shrink-0">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Assign to Signer
            </label>
            <Select
              value={selectedSignerId?.toString() ?? ""}
              onValueChange={(v) => setSelectedSignerId(Number(v))}
            >
              <SelectTrigger data-testid="select-signer">
                <SelectValue placeholder="Select signer" />
              </SelectTrigger>
              <SelectContent>
                {envelope.signers.map((s) => (
                  <SelectItem key={s.id} value={s.id.toString()}>
                    {s.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Editor Mode
            </label>
            <Select
              value={editorMode}
              onValueChange={(v) => {
                const next = v as EditorMode;
                setEditorMode(next);
                if (next === "free") setMaxUnlockedPage(totalPages);
              }}
            >
              <SelectTrigger data-testid="select-editor-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="guided" data-testid="option-editor-mode-guided">
                  <span className="flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5" />
                    Guided (page-by-page)
                  </span>
                </SelectItem>
                <SelectItem value="free" data-testid="option-editor-mode-free">
                  <span className="flex items-center gap-2">
                    <Unlock className="h-3.5 w-3.5" />
                    Free (all pages)
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground/80 mt-1.5 leading-snug">
              {editorMode === "guided"
                ? "Confirm each page complete before the next unlocks."
                : "All pages are scrollable and editable at once."}
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Signature Placement
            </label>
            <Select
              value={placementMode}
              onValueChange={(v) => {
                const mode = v as SignaturePlacementMode;
                const previous = placementMode;
                setPlacementMode(mode);
                placementModeMutation.mutate({ mode, previous });
              }}
              disabled={placementModeMutation.isPending}
            >
              <SelectTrigger data-testid="select-placement-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed_bottom_centre" data-testid="option-mode-fixed">
                  <span className="flex items-center gap-2">
                    <Lock className="h-3.5 w-3.5" />
                    Bottom-centre (locked)
                  </span>
                </SelectItem>
                <SelectItem value="admin_placed" data-testid="option-mode-admin">
                  <span className="flex items-center gap-2">
                    <Move className="h-3.5 w-3.5" />
                    Admin-placed (free)
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground/80 mt-1.5 leading-snug">
              {placementMode === "admin_placed"
                ? "Signature box uses the field position you drag below."
                : "Signature box is forced to the page bottom regardless of where you drop the field."}
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Add Field
            </label>
            <div className="flex flex-col gap-2">
              {(["signature", "initial", "date"] as FieldType[]).map((type) => {
                const Icon = FIELD_ICONS[type];
                return (
                  <Button
                    key={type}
                    variant="outline"
                    size="sm"
                    className="justify-start gap-2"
                    onClick={() => addField(type)}
                    disabled={!selectedSignerId}
                    data-testid={`button-add-${type}`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {FIELD_DEFAULTS[type].label}
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="border-t pt-4">
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Fields on Page {currentPage}
            </label>
            {currentPageFields.length === 0 ? (
              <p className="text-xs text-muted-foreground/60">No fields placed on this page</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {currentPageFields.map((f) => {
                  const Icon = FIELD_ICONS[f.type];
                  const isSelected = selectedFieldIndex === f.index;
                  return (
                    <div
                      key={f.index}
                      ref={(el) => {
                        if (el) sidebarFieldRefs.current.set(f.index, el);
                        else sidebarFieldRefs.current.delete(f.index);
                      }}
                      onClick={() => onSidebarFieldClick(f.index, f.pageNumber)}
                      className={`flex items-center justify-between gap-1 text-xs rounded p-1.5 border cursor-pointer transition-colors ${
                        isSelected
                          ? "bg-primary/10 border-primary ring-1 ring-primary"
                          : "bg-background hover:bg-muted/40"
                      }`}
                      data-testid={`sidebar-field-row-${f.index}`}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Icon className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{signerName(f.signerId)}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeField(f.index);
                        }}
                        data-testid={`button-remove-field-${f.index}`}
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            {selectedFieldIndex !== null && (
              <p className="text-[10px] text-muted-foreground/70 mt-1.5 italic">
                Press Delete or Backspace to remove the selected field.
              </p>
            )}
          </div>

          <div className="border-t pt-4">
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Per-Signer Checklist
            </label>
            <div className="flex flex-col gap-2">
              {envelope.signers.map((s) => {
                const expanded = expandedSigners.has(s.id);
                const sigCount = fields.filter((f) => f.signerId === s.id && f.type === "signature").length;
                const initCount = fields.filter((f) => f.signerId === s.id && f.type === "initial").length;
                const dateCount = fields.filter((f) => f.signerId === s.id && f.type === "date").length;
                const pagesWithoutInitial: number[] = [];
                for (let p = 1; p <= totalPages; p++) {
                  if (!fields.some((f) => f.signerId === s.id && f.type === "initial" && f.pageNumber === p)) {
                    pagesWithoutInitial.push(p);
                  }
                }
                const missingSig = placementMode === "admin_placed" && sigCount === 0;
                return (
                  <div
                    key={s.id}
                    className="rounded border bg-background"
                    data-testid={`checklist-signer-${s.id}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSignerExpanded(s.id)}
                      className="w-full flex items-center justify-between gap-2 p-2 text-left"
                      data-testid={`button-toggle-signer-${s.id}`}
                    >
                      <span className="text-xs font-medium truncate flex-1">{s.fullName}</span>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {missingSig && (
                          <AlertTriangle className="h-3 w-3 text-amber-500" />
                        )}
                        <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                          {sigCount + initCount + dateCount}
                        </Badge>
                        <ChevronDown
                          className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
                        />
                      </div>
                    </button>
                    {expanded && (
                      <div className="px-2 pb-2 text-[11px] space-y-1 text-muted-foreground">
                        <div className="flex justify-between">
                          <span className="flex items-center gap-1">
                            <span className={`h-1.5 w-1.5 rounded-full ${FIELD_DOT_COLORS.signature}`} />
                            Signatures
                          </span>
                          <span>{sigCount}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="flex items-center gap-1">
                            <span className={`h-1.5 w-1.5 rounded-full ${FIELD_DOT_COLORS.initial}`} />
                            Initials
                          </span>
                          <span>{initCount}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="flex items-center gap-1">
                            <span className={`h-1.5 w-1.5 rounded-full ${FIELD_DOT_COLORS.date}`} />
                            Dates
                          </span>
                          <span>{dateCount}</span>
                        </div>
                        {pagesWithoutInitial.length > 0 && (
                          <div className="pt-1 border-t">
                            <p className="text-amber-600 dark:text-amber-400">
                              No initial on page{pagesWithoutInitial.length > 1 ? "s" : ""}: {pagesWithoutInitial.join(", ")}
                            </p>
                          </div>
                        )}
                        {missingSig && (
                          <p className="text-amber-600 dark:text-amber-400 pt-1 border-t">
                            No signature placed.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Page rail */}
        <div
          className="w-24 border-r bg-muted/20 overflow-y-auto flex-shrink-0 py-3 px-2 flex flex-col gap-2"
          data-testid="page-rail"
        >
          {Array.from({ length: totalPages }, (_, i) => {
            const pageNum = i + 1;
            const summary = pageSummary(pageNum);
            const isLocked = editorMode === "guided" && pageNum > maxUnlockedPage;
            const isActive = pageNum === currentPage;
            const isLastPageWithLockedSig =
              pageNum === totalPages && placementMode === "fixed_bottom_centre";
            return (
              <button
                key={pageNum}
                type="button"
                onClick={() => goToRailPage(pageNum)}
                className={`relative w-full aspect-[8.5/11] rounded border-2 transition-all flex flex-col items-center justify-center gap-1 text-xs font-medium ${
                  isActive
                    ? "border-primary bg-primary/10 shadow"
                    : isLocked
                      ? "border-dashed border-muted-foreground/30 bg-muted/40 text-muted-foreground/50"
                      : "border-muted-foreground/20 bg-background hover:border-primary/50 hover:bg-muted/40"
                }`}
                data-testid={`button-page-rail-${pageNum}`}
              >
                <span>P{pageNum}</span>
                {isLastPageWithLockedSig && (
                  <span
                    className="absolute left-1/4 right-1/4 bottom-1 h-1.5 rounded-sm bg-green-500/40 border border-green-600/50"
                    data-testid={`rail-locked-sig-ghost-${pageNum}`}
                    title="Signature will be stamped here"
                  />
                )}
                <div className="flex gap-0.5">
                  {(["signature", "initial", "date"] as FieldType[]).map((t) =>
                    summary.counts[t] > 0 ? (
                      <span key={t} className={`h-1.5 w-1.5 rounded-full ${FIELD_DOT_COLORS[t]}`} />
                    ) : null
                  )}
                </div>
                {summary.completeForSelected && (
                  <Check className="h-3 w-3 text-green-600 absolute top-1 right-1" data-testid={`rail-complete-${pageNum}`} />
                )}
                {isLocked && (
                  <Lock className="h-3 w-3 text-muted-foreground/50 absolute top-1 left-1" />
                )}
              </button>
            );
          })}
        </div>

        {/* Canvas */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-2 border-b bg-background flex-shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => goToRailPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground" data-testid="text-page-indicator">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => goToRailPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage >= totalPages}
              data-testid="button-next-page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <div
            ref={canvasScrollRef}
            className="flex-1 overflow-auto p-4 bg-muted/20"
            onClick={handleCanvasBgClick}
            data-testid="canvas-scroll"
          >
            <div className="mx-auto flex flex-col gap-6" style={{ maxWidth: "800px" }}>
              {visiblePages.map((pageNum) => {
                const onPage = fieldsOnPage(pageNum);
                const isActive = pageNum === currentPage;
                return (
                  <div
                    key={pageNum}
                    ref={(el) => {
                      if (el) {
                        pageRefs.current.set(pageNum, el);
                        (el as HTMLDivElement).dataset.page = String(pageNum);
                      } else {
                        pageRefs.current.delete(pageNum);
                      }
                    }}
                    data-testid={`page-frame-${pageNum}`}
                    className="space-y-1"
                  >
                    <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                      <span className="font-medium" data-testid={`label-page-frame-${pageNum}`}>
                        Page {pageNum}
                      </span>
                      {pageSummary(pageNum).total > 0 && (
                        <span>{pageSummary(pageNum).total} field{pageSummary(pageNum).total === 1 ? "" : "s"}</span>
                      )}
                    </div>
                    <div
                      className={`relative bg-white dark:bg-gray-900 rounded-lg shadow-sm border-2 transition-colors ${
                        isActive ? "border-primary" : "border-transparent"
                      }`}
                      style={{ aspectRatio: "8.5/11" }}
                    >
                      {envelope.originalPdfUrl ? (
                        <iframe
                          src={`${envelope.originalPdfUrl}#page=${pageNum}&toolbar=0&navpanes=0&scrollbar=0`}
                          className="w-full h-full border-0 rounded-lg pointer-events-none"
                          title={`Document page ${pageNum}`}
                          data-testid={`pdf-preview-${pageNum}`}
                        />
                      ) : (
                        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                          No PDF uploaded
                        </div>
                      )}

                      <div
                        ref={(el) => {
                          if (el) overlayRefs.current.set(pageNum, el);
                          else overlayRefs.current.delete(pageNum);
                        }}
                        className="absolute inset-0 rounded-lg"
                        style={{ cursor: draggingField !== null ? "grabbing" : "default" }}
                        onMouseMove={(e) => handleMouseMove(e, pageNum)}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseUp}
                        onClick={(e) => {
                          if (e.target === e.currentTarget) setSelectedFieldIndex(null);
                        }}
                        data-testid={`field-overlay-${pageNum}`}
                      >
                        {placementMode === "fixed_bottom_centre" && pageNum === totalPages && (
                          <div
                            className="absolute border-2 border-dashed border-red-500 bg-red-50/40 dark:bg-red-950/20 rounded flex items-center justify-center text-[10px] font-medium text-red-700 dark:text-red-300 pointer-events-none"
                            style={{
                              left: "37.5%",
                              width: "25%",
                              bottom: "3%",
                              height: "10%",
                            }}
                            data-testid="preview-locked-signature"
                          >
                            <Lock className="h-3 w-3 mr-1" /> Locked signature
                          </div>
                        )}
                        {onPage.map((f) => {
                          const Icon = FIELD_ICONS[f.type];
                          const isSelected = selectedFieldIndex === f.index;
                          return (
                            <div
                              key={f.index}
                              className={`absolute border-2 rounded flex items-center justify-center gap-1 text-[10px] font-medium select-none ${FIELD_COLORS[f.type]} ${
                                draggingField === f.index
                                  ? "opacity-80 shadow-lg ring-2 ring-primary"
                                  : isSelected
                                    ? "ring-2 ring-primary ring-offset-1 shadow-md"
                                    : "hover:shadow-md"
                              }`}
                              style={{
                                left: `${f.xPos * 100}%`,
                                top: `${f.yPos * 100}%`,
                                width: `${f.width * 100}%`,
                                height: `${f.height * 100}%`,
                                cursor: draggingField === f.index ? "grabbing" : "grab",
                              }}
                              onMouseDown={(e) => handleMouseDown(e, f.index)}
                              data-testid={`field-${f.type}-${f.index}`}
                            >
                              <GripVertical className="h-3 w-3 opacity-40" />
                              <Icon className="h-3 w-3" />
                              <span className="truncate max-w-[60px]">{signerName(f.signerId)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}

              {editorMode === "guided" && maxUnlockedPage < totalPages && (
                <div
                  className="rounded-lg border-2 border-dashed border-primary/40 bg-primary/5 p-6 text-center space-y-3"
                  data-testid="guided-next-prompt"
                >
                  <Lock className="h-6 w-6 text-primary mx-auto" />
                  <p className="text-sm font-semibold">
                    Page {maxUnlockedPage} is the current working page.
                  </p>
                  <p className="text-xs text-muted-foreground max-w-md mx-auto">
                    When you have placed all the fields you need on this page, confirm it
                    complete to unlock page {maxUnlockedPage + 1}.
                  </p>
                  <Button
                    onClick={() => setConfirmPageOpen(maxUnlockedPage)}
                    data-testid="button-confirm-page-complete"
                  >
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Page {maxUnlockedPage} complete — continue to page {maxUnlockedPage + 1}
                  </Button>
                </div>
              )}

              {editorMode === "guided" && maxUnlockedPage >= totalPages && (
                <div
                  className="rounded-lg border-2 border-dashed border-green-500/40 bg-green-50/40 dark:bg-green-950/20 p-4 text-center"
                  data-testid="guided-all-unlocked"
                >
                  <p className="text-sm font-medium text-green-700 dark:text-green-400">
                    All pages unlocked. Review the per-signer checklist on the left, then save.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Confirm page complete dialog */}
      <Dialog open={confirmPageOpen !== null} onOpenChange={(open) => !open && setConfirmPageOpen(null)}>
        <DialogContent data-testid="dialog-confirm-page-complete">
          <DialogHeader>
            <DialogTitle>
              Page {confirmPageOpen} complete?
            </DialogTitle>
            <DialogDescription>
              Once you continue, page {(confirmPageOpen ?? 0) + 1} unlocks for editing. You can
              still come back to page {confirmPageOpen} from the page rail at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmPageOpen(null)}
              data-testid="button-cancel-page-complete"
            >
              Stay on this page
            </Button>
            <Button onClick={confirmCurrentPageComplete} data-testid="button-confirm-page-complete-go">
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Yes, continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Save warning dialog (missing signatures and/or missing initials) */}
      <Dialog open={savePromptOpen !== null} onOpenChange={(open) => !open && setSavePromptOpen(null)}>
        <DialogContent data-testid="dialog-save-warning">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Some fields are missing
            </DialogTitle>
            <DialogDescription>
              You can still save, but the following gaps may make it harder for signers to
              complete the document:
            </DialogDescription>
          </DialogHeader>
          {savePromptOpen?.missingSignature.length ? (
            <div className="text-sm space-y-1" data-testid="save-warning-section-signature">
              <p className="font-medium">
                Signers with no signature field
                <span className="text-xs text-muted-foreground ml-1">(admin-placed mode)</span>
              </p>
              <ul className="list-disc list-inside text-sm space-y-1">
                {savePromptOpen.missingSignature.map((name) => (
                  <li key={name} data-testid={`save-warning-missing-${name}`}>{name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {savePromptOpen?.pagesMissingInitial.length ? (
            <div className="text-sm space-y-1" data-testid="save-warning-section-initial">
              <p className="font-medium">Pages with no initial</p>
              <ul className="list-disc list-inside text-sm space-y-1">
                {savePromptOpen.pagesMissingInitial.map(({ signer, pages }) => (
                  <li key={signer} data-testid={`save-warning-noinitial-${signer}`}>
                    {signer}: page{pages.length > 1 ? "s" : ""} {pages.join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Add the missing fields and try again, or save anyway.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSavePromptOpen(null)}
              data-testid="button-cancel-save"
            >
              Cancel — keep editing
            </Button>
            <Button
              onClick={() => {
                setSavePromptOpen(null);
                saveMutation.mutate();
              }}
              data-testid="button-save-anyway"
            >
              Save anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
