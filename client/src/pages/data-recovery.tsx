import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import {
  ChevronLeft, Database, Trash2, Download, Plus, RotateCcw, CheckCircle2,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { Envelope, Backup } from "@shared/schema";

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) + ", " +
    d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export default function DataRecovery() {
  const { toast } = useToast();

  const { data: deletedEnvelopes = [], isLoading: loadingDeleted } = useQuery<Envelope[]>({
    queryKey: ["/api/envelopes/deleted"],
  });

  const { data: backupsList = [], isLoading: loadingBackups } = useQuery<Backup[]>({
    queryKey: ["/api/backups"],
  });

  const restoreMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/envelopes/${id}/restore`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/envelopes/deleted"] });
      queryClient.invalidateQueries({ queryKey: ["/api/envelopes"] });
      toast({ title: "Enveloppe restaur\u00e9e" });
    },
  });

  const createBackupMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/backups"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backups"] });
      toast({ title: "Sauvegarde cr\u00e9\u00e9e" });
    },
  });

  const deleteBackupMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/backups/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backups"] });
      toast({ title: "Sauvegarde supprim\u00e9e" });
    },
  });

  function handleDownload(backup: Backup) {
    window.open(`/api/backups/${backup.id}/download`, "_blank");
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
            <div className="p-2.5 rounded-full bg-teal-600 dark:bg-teal-700">
              <Database className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold" data-testid="text-page-title">Data Recovery</h1>
              <p className="text-sm text-muted-foreground uppercase tracking-wider">R\u00e9cup\u00e9rer les projets supprim\u00e9s &amp; g\u00e9rer les sauvegardes</p>
            </div>
          </div>
          <Button
            onClick={() => createBackupMutation.mutate()}
            disabled={createBackupMutation.isPending}
            className="bg-green-600 hover:bg-green-700 text-white"
            data-testid="button-create-backup"
          >
            <Plus className="h-4 w-4 mr-2" />
            {createBackupMutation.isPending ? "Cr\u00e9ation..." : "Cr\u00e9er Backup"}
          </Button>
        </div>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-3 mb-4">
              <Trash2 className="h-5 w-5 text-muted-foreground" />
              <h2 className="font-bold uppercase tracking-wider text-sm" data-testid="text-deleted-section">Projets Supprim\u00e9s</h2>
              <Badge variant="destructive" className="no-default-hover-elevate no-default-active-elevate" data-testid="badge-deleted-count">
                {deletedEnvelopes.length} trouv\u00e9(s)
              </Badge>
            </div>

            {loadingDeleted ? (
              <p className="text-center text-muted-foreground py-8">Chargement...</p>
            ) : deletedEnvelopes.length === 0 ? (
              <div className="text-center py-8 space-y-2">
                <CheckCircle2 className="h-10 w-10 text-green-500 mx-auto" />
                <p className="text-muted-foreground font-medium">Aucun projet supprim\u00e9</p>
                <p className="text-sm text-muted-foreground">Tous les projets sont actifs</p>
              </div>
            ) : (
              <div className="space-y-3">
                {deletedEnvelopes.map((env) => (
                  <div
                    key={env.id}
                    className="flex items-center justify-between gap-4 p-3 rounded-md border"
                    data-testid={`row-deleted-${env.id}`}
                  >
                    <div>
                      <p className="font-medium" data-testid={`text-deleted-subject-${env.id}`}>{env.subject}</p>
                      <p className="text-xs text-muted-foreground">
                        Supprim\u00e9 le {formatDate(env.deletedAt as unknown as string)}
                        {env.externalRef && ` \u2022 Ref: ${env.externalRef}`}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => restoreMutation.mutate(env.id)}
                      disabled={restoreMutation.isPending}
                      data-testid={`button-restore-${env.id}`}
                    >
                      <RotateCcw className="h-4 w-4 mr-1" />
                      Restaurer
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-3 mb-4">
              <Database className="h-5 w-5 text-muted-foreground" />
              <h2 className="font-bold uppercase tracking-wider text-sm" data-testid="text-backups-section">Sauvegardes Disponibles</h2>
              <Badge variant="secondary" className="no-default-hover-elevate no-default-active-elevate" data-testid="badge-backup-count">
                {backupsList.length} sauvegarde(s)
              </Badge>
            </div>

            {loadingBackups ? (
              <p className="text-center text-muted-foreground py-8">Chargement...</p>
            ) : backupsList.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">Aucune sauvegarde disponible</p>
            ) : (
              <div className="space-y-3">
                {backupsList.map((backup) => (
                  <div
                    key={backup.id}
                    className="flex items-center justify-between gap-4 p-3 rounded-md border"
                    data-testid={`row-backup-${backup.id}`}
                  >
                    <div>
                      <p className="font-mono text-sm font-medium" data-testid={`text-backup-filename-${backup.id}`}>{backup.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        Cr\u00e9\u00e9: {formatDate(backup.createdAt as unknown as string)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDownload(backup)}
                        data-testid={`button-download-${backup.id}`}
                      >
                        <Download className="h-4 w-4 mr-1" />
                        T\u00e9l\u00e9charger
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="icon" variant="ghost" data-testid={`button-delete-backup-${backup.id}`}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Supprimer cette sauvegarde ?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Le fichier &quot;{backup.filename}&quot; sera d\u00e9finitivement supprim\u00e9.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Annuler</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteBackupMutation.mutate(backup.id)}>
                              Supprimer
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
