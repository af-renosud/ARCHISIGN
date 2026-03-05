import { useState, useRef, useCallback, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  PenTool,
  Type,
  Calendar,
  Trash2,
  GripVertical,
  Save,
} from "lucide-react";
import type { Envelope, Signer, Annotation } from "@shared/schema";

type FieldType = "signature" | "initial" | "date";

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

const FIELD_ICONS: Record<FieldType, typeof PenTool> = {
  signature: PenTool,
  initial: Type,
  date: Calendar,
};

export default function EnvelopeFieldEditor() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [currentPage, setCurrentPage] = useState(1);
  const [fields, setFields] = useState<PlacedField[]>([]);
  const [selectedSignerId, setSelectedSignerId] = useState<number | null>(null);
  const [draggingField, setDraggingField] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const overlayRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);

  const { data: envelope, isLoading } = useQuery<
    Envelope & { signers: Signer[] }
  >({
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
    }
  }, [existingAnnotations, loaded]);

  useEffect(() => {
    if (envelope?.signers?.length && !selectedSignerId) {
      setSelectedSignerId(envelope.signers[0].id);
    }
  }, [envelope, selectedSignerId]);

  const saveMutation = useMutation({
    mutationFn: async () => {
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
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/envelopes", id, "annotations"] });
      setLoaded(false);
      toast({ title: "Fields saved", description: "Annotation placements have been saved." });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const addField = useCallback(
    (type: FieldType) => {
      if (!selectedSignerId) return;
      const defaults = FIELD_DEFAULTS[type];
      setFields((prev) => [
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
      ]);
    },
    [selectedSignerId, currentPage]
  );

  const removeField = useCallback((index: number) => {
    setFields((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.preventDefault();
      e.stopPropagation();
      const overlay = overlayRef.current;
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      const field = fields[index];
      const fieldXPx = field.xPos * rect.width;
      const fieldYPx = field.yPos * rect.height;
      setDragOffset({
        x: e.clientX - rect.left - fieldXPx,
        y: e.clientY - rect.top - fieldYPx,
      });
      setDraggingField(index);
    },
    [fields]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (draggingField === null) return;
      const overlay = overlayRef.current;
      if (!overlay) return;
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
    [draggingField, dragOffset]
  );

  const handleMouseUp = useCallback(() => {
    setDraggingField(null);
  }, []);

  const currentPageFields = fields
    .map((f, i) => ({ ...f, index: i }))
    .filter((f) => f.pageNumber === currentPage);

  const signerName = (signerId: number) =>
    envelope?.signers.find((s) => s.id === signerId)?.fullName ?? "Unknown";

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
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(`/envelopes/${id}`)} data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-sm font-semibold" data-testid="text-editor-title">
              Place Fields — {envelope.subject}
            </h1>
            <p className="text-xs text-muted-foreground">
              Drag and position signature, initial, and date fields on the document
            </p>
          </div>
        </div>
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          data-testid="button-save-fields"
        >
          <Save className="h-4 w-4 mr-2" />
          {saveMutation.isPending ? "Saving..." : "Save Fields"}
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
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
                {currentPageFields.map((f) => (
                  <div
                    key={f.index}
                    className="flex items-center justify-between gap-1 text-xs bg-background rounded p-1.5 border"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {(() => {
                        const Icon = FIELD_ICONS[f.type];
                        return <Icon className="h-3 w-3 flex-shrink-0" />;
                      })()}
                      <span className="truncate">{signerName(f.signerId)}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0"
                      onClick={() => removeField(f.index)}
                      data-testid={`button-remove-field-${f.index}`}
                    >
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t pt-4">
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              All Placed Fields
            </label>
            <div className="text-xs text-muted-foreground space-y-0.5">
              {(["signature", "initial", "date"] as FieldType[]).map((type) => {
                const count = fields.filter((f) => f.type === type).length;
                return (
                  <div key={type} className="flex justify-between">
                    <span>{FIELD_DEFAULTS[type].label}s</span>
                    <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                      {count}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-2 border-b bg-background flex-shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground" data-testid="text-page-indicator">
              Page {currentPage} of {envelope.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.min(envelope.totalPages, p + 1))}
              disabled={currentPage >= envelope.totalPages}
              data-testid="button-next-page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex-1 overflow-auto p-4 bg-muted/20">
            <div className="mx-auto" style={{ maxWidth: "800px" }}>
              <div
                className="relative bg-white dark:bg-gray-900 rounded-lg shadow-sm border"
                style={{ aspectRatio: "8.5/11" }}
              >
                {envelope.originalPdfUrl ? (
                  <iframe
                    src={`${envelope.originalPdfUrl}#page=${currentPage}`}
                    className="w-full h-full border-0 rounded-lg pointer-events-none"
                    title={`Document page ${currentPage}`}
                    data-testid="pdf-preview"
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                    No PDF uploaded
                  </div>
                )}

                <div
                  ref={overlayRef}
                  className="absolute inset-0 rounded-lg"
                  style={{ cursor: draggingField !== null ? "grabbing" : "default" }}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  data-testid="field-overlay"
                >
                  {currentPageFields.map((f) => {
                    const Icon = FIELD_ICONS[f.type];
                    return (
                      <div
                        key={f.index}
                        className={`absolute border-2 rounded flex items-center justify-center gap-1 text-[10px] font-medium select-none ${FIELD_COLORS[f.type]} ${draggingField === f.index ? "opacity-80 shadow-lg ring-2 ring-primary" : "hover:shadow-md"}`}
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
          </div>
        </div>
      </div>
    </div>
  );
}
