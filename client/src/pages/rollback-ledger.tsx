import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import {
  ChevronLeft, History, Plus, Copy, Pencil, Trash2,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { RollbackVersion } from "@shared/schema";

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

export default function RollbackLedger() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formLabel, setFormLabel] = useState("");
  const [formNote, setFormNote] = useState("");
  const [formStatus, setFormStatus] = useState<"active" | "superseded">("active");

  const { data: versions = [], isLoading } = useQuery<RollbackVersion[]>({
    queryKey: ["/api/rollback-versions"],
  });

  const createMutation = useMutation({
    mutationFn: (data: { versionLabel: string; note: string | null; status: string }) =>
      apiRequest("POST", "/api/rollback-versions", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rollback-versions"] });
      toast({ title: "Version cr\u00e9\u00e9e" });
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<RollbackVersion> }) =>
      apiRequest("PATCH", `/api/rollback-versions/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rollback-versions"] });
      toast({ title: "Version mise \u00e0 jour" });
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/rollback-versions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rollback-versions"] });
      toast({ title: "Version supprim\u00e9e" });
    },
  });

  function resetForm() {
    setDialogOpen(false);
    setEditingId(null);
    setFormLabel("");
    setFormNote("");
    setFormStatus("active");
  }

  function openNew() {
    resetForm();
    setDialogOpen(true);
  }

  function openEdit(v: RollbackVersion) {
    setEditingId(v.id);
    setFormLabel(v.versionLabel);
    setFormNote(v.note || "");
    setFormStatus(v.status);
    setDialogOpen(true);
  }

  function handleSubmit() {
    if (!formLabel.trim()) return;
    if (editingId) {
      updateMutation.mutate({ id: editingId, data: { versionLabel: formLabel, note: formNote || null, status: formStatus } });
    } else {
      createMutation.mutate({ versionLabel: formLabel, note: formNote || null, status: formStatus });
    }
  }

  async function handleCopy(v: RollbackVersion) {
    try {
      await navigator.clipboard.writeText(`${v.versionLabel} | ${v.status} | ${formatDate(v.createdAt as unknown as string)}`);
      toast({ title: "Copi\u00e9", description: "Version copi\u00e9e dans le presse-papiers" });
    } catch {
      toast({ title: "Erreur", variant: "destructive" });
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Link href="/settings" data-testid="link-back-settings">
            <Button variant="ghost" size="sm">
              <ChevronLeft className="h-4 w-4 mr-1" />
              Retour aux param\u00e8tres
            </Button>
          </Link>
        </div>

        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-full bg-slate-800 dark:bg-slate-700">
              <History className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold" data-testid="text-page-title">Rollback Ledger</h1>
              <p className="text-sm text-muted-foreground uppercase tracking-wider">Documentation des versions de r\u00e9cup\u00e9ration</p>
            </div>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={openNew} data-testid="button-new-version" className="bg-slate-800 hover:bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900">
                <Plus className="h-4 w-4 mr-2" />
                Nouvelle Version
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingId ? "Modifier la version" : "Nouvelle version"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div>
                  <label className="text-sm font-medium mb-1 block">Version</label>
                  <Input
                    value={formLabel}
                    onChange={(e) => setFormLabel(e.target.value)}
                    placeholder="Archisign V1.0.0"
                    data-testid="input-version-label"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Note</label>
                  <Textarea
                    value={formNote}
                    onChange={(e) => setFormNote(e.target.value)}
                    placeholder="Notes optionnelles..."
                    data-testid="input-version-note"
                    className="resize-none"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Statut</label>
                  <div className="flex gap-2">
                    <Button
                      variant={formStatus === "active" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setFormStatus("active")}
                      data-testid="button-status-active"
                    >
                      Active
                    </Button>
                    <Button
                      variant={formStatus === "superseded" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setFormStatus("superseded")}
                      data-testid="button-status-superseded"
                    >
                      Superseded
                    </Button>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={resetForm}>Annuler</Button>
                <Button
                  onClick={handleSubmit}
                  disabled={!formLabel.trim() || createMutation.isPending || updateMutation.isPending}
                  data-testid="button-submit-version"
                >
                  {editingId ? "Enregistrer" : "Cr\u00e9er"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-muted-foreground uppercase tracking-wider">
                    <th className="px-6 py-3 font-medium">Version</th>
                    <th className="px-6 py-3 font-medium">Note</th>
                    <th className="px-6 py-3 font-medium">Statut</th>
                    <th className="px-6 py-3 font-medium">Date</th>
                    <th className="px-6 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">Chargement...</td>
                    </tr>
                  ) : versions.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">Aucune version enregistr\u00e9e</td>
                    </tr>
                  ) : (
                    versions.map((v) => (
                      <tr key={v.id} className="border-b last:border-0" data-testid={`row-version-${v.id}`}>
                        <td className="px-6 py-4 font-mono font-medium" data-testid={`text-version-label-${v.id}`}>{v.versionLabel}</td>
                        <td className="px-6 py-4 text-muted-foreground text-sm">{v.note || "\u2013"}</td>
                        <td className="px-6 py-4">
                          <Badge
                            variant={v.status === "active" ? "default" : "secondary"}
                            className={v.status === "active" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 no-default-hover-elevate no-default-active-elevate" : "no-default-hover-elevate no-default-active-elevate"}
                            data-testid={`badge-status-${v.id}`}
                          >
                            {v.status.toUpperCase()}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 text-sm text-muted-foreground">{formatDate(v.createdAt as unknown as string)}</td>
                        <td className="px-6 py-4">
                          <div className="flex items-center justify-end gap-1">
                            <Button size="icon" variant="ghost" onClick={() => handleCopy(v)} data-testid={`button-copy-${v.id}`}>
                              <Copy className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => openEdit(v)} data-testid={`button-edit-${v.id}`}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button size="icon" variant="ghost" data-testid={`button-delete-${v.id}`}>
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Supprimer cette version ?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    La version &quot;{v.versionLabel}&quot; sera d\u00e9finitivement supprim\u00e9e.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Annuler</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => deleteMutation.mutate(v.id)} data-testid={`button-confirm-delete-${v.id}`}>
                                    Supprimer
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
