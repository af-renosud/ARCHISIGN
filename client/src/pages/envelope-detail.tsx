import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  ArrowLeft, Send, Copy, ExternalLink, FileText, Eye, Clock,
  AlertTriangle, CheckCircle2, MessageSquare, Shield, Users, Trash2, RefreshCw, PenTool,
  KeyRound, EyeOff, Award, Fingerprint, Download
} from "lucide-react";
import type { Envelope, Signer, CommunicationLog, AuditEvent, Contact } from "@shared/schema";
import { buildSharedEmailMap, isSharedInbox } from "@/components/ContactCombobox";
import { Users as UsersIcon } from "lucide-react";
import { format } from "date-fns";
import { useState, useMemo } from "react";

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: any; color: string }> = {
  draft: { label: "Draft", variant: "secondary", icon: FileText, color: "text-muted-foreground" },
  sent: { label: "Sent", variant: "default", icon: Send, color: "text-primary" },
  viewed: { label: "Viewed", variant: "outline", icon: Eye, color: "text-blue-600 dark:text-blue-400" },
  queried: { label: "Queried", variant: "destructive", icon: AlertTriangle, color: "text-destructive" },
  signed: { label: "Signed", variant: "default", icon: CheckCircle2, color: "text-green-600 dark:text-green-400" },
  declined: { label: "Declined", variant: "destructive", icon: AlertTriangle, color: "text-destructive" },
};

type EnvelopeDetail = Envelope & {
  signers: Signer[];
  communicationLogs: CommunicationLog[];
  auditEvents: AuditEvent[];
};

interface CredentialRowProps {
  label: string;
  value: string;
  signerId: number;
  field: string;
  onCopy: (value: string, label: string) => void;
  mono?: boolean;
  sensitive?: boolean;
}

function CredentialRow({ label, value, signerId, field, onCopy, mono, sensitive }: CredentialRowProps) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground" data-testid={`label-cred-${field}-${signerId}`}>
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <code
          className={`flex-1 min-w-0 truncate text-xs px-3 py-2 rounded-md bg-muted ${mono ? "font-mono" : ""} ${sensitive ? "select-all" : ""}`}
          data-testid={`text-cred-${field}-${signerId}`}
          title={value}
        >
          {value}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onCopy(value, label)}
          data-testid={`button-copy-${field}-${signerId}`}
        >
          <Copy className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

export default function EnvelopeDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [replyMessage, setReplyMessage] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [resendDialogOpen, setResendDialogOpen] = useState(false);
  const [resendMessage, setResendMessage] = useState("");
  const [revealedCreds, setRevealedCreds] = useState<Record<number, boolean>>({});

  const { data: envelope, isLoading } = useQuery<EnvelopeDetail>({
    queryKey: ["/api/envelopes", id],
    enabled: !!id,
    refetchInterval: 30000,
  });

  // v1.3.2: surface a shared-inbox warning chip next to any signer whose email
  // resolves to >1 active contact across both sources. Read-only echo of the
  // pre-send picker warning. URL-only queryKey so the default queryFn (which
  // does queryKey.join("/")) hits /api/contacts cleanly.
  const { data: contacts } = useQuery<Contact[]>({ queryKey: ["/api/contacts"] });
  const sharedEmailMap = useMemo(() => buildSharedEmailMap(contacts), [contacts]);

  const sendMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/envelopes/${id}/send`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/envelopes", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/envelopes"] });
      toast({ title: "Envelope sent", description: "Signing invitations have been emailed to all signers." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const replyMutation = useMutation({
    mutationFn: (message: string) => apiRequest("POST", `/api/envelopes/${id}/reply`, { message }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/envelopes", id] });
      setReplyMessage("");
      toast({ title: "Reply sent", description: "Your response has been sent via email." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const resendMutation = useMutation({
    mutationFn: (message: string) =>
      apiRequest("POST", `/api/envelopes/${id}/resend`, message.trim() ? { message: message.trim() } : {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/envelopes", id] });
      setResendDialogOpen(false);
      setResendMessage("");
      toast({ title: "Invitations resent", description: "Reminder emails have been sent to all pending signers." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (reason: string) => apiRequest("POST", `/api/envelopes/${id}/soft-delete`, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/envelopes"] });
      setDeleteDialogOpen(false);
      setDeleteReason("");
      toast({ title: "Envelope deleted", description: "The envelope has been moved to the deleted items." });
      navigate("/");
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!envelope) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-16">
        <FileText className="h-12 w-12 text-muted-foreground/40 mb-4" />
        <h3 className="font-medium text-muted-foreground">Envelope not found</h3>
        <Button variant="outline" onClick={() => navigate("/")} className="mt-4" data-testid="button-back-not-found">
          Back to Dashboard
        </Button>
      </div>
    );
  }

  const config = statusConfig[envelope.status] || statusConfig.draft;
  const StatusIcon = config.icon;

  const copySigningLink = (token: string) => {
    const url = `${window.location.origin}/sign/${token}`;
    navigator.clipboard.writeText(url);
    toast({ title: "Link copied", description: "Signing link copied to clipboard." });
  };

  const copyValue = (value: string, label: string) => {
    navigator.clipboard.writeText(value);
    toast({ title: `${label} copied`, description: "Value copied to clipboard." });
  };

  const toggleReveal = (signerId: number) => {
    setRevealedCreds((prev) => ({ ...prev, [signerId]: !prev[signerId] }));
  };

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")} data-testid="button-back-detail">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-semibold truncate" data-testid="text-envelope-subject">{envelope.subject}</h1>
              <Badge variant={config.variant} data-testid="badge-envelope-detail-status">
                <StatusIcon className="h-3 w-3 mr-1" />
                {config.label}
              </Badge>
            </div>
            <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground flex-wrap">
              {envelope.externalRef && <span>Ref: {envelope.externalRef}</span>}
              <span>Created {format(new Date(envelope.createdAt), "MMM d, yyyy 'at' h:mm a")}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {envelope.status === "draft" && (
              <>
                <Button variant="outline" onClick={() => navigate(`/envelopes/${id}/fields`)} data-testid="button-place-fields">
                  <PenTool className="h-4 w-4 mr-2" />
                  Place Fields
                </Button>
                <Button onClick={() => sendMutation.mutate()} disabled={sendMutation.isPending} data-testid="button-send-envelope">
                  <Send className="h-4 w-4 mr-2" />
                  {sendMutation.isPending ? "Sending..." : "Send for Signing"}
                </Button>
              </>
            )}
            {["sent", "viewed", "queried"].includes(envelope.status) && (
              <Button variant="outline" onClick={() => setResendDialogOpen(true)} disabled={resendMutation.isPending} data-testid="button-resend-envelope">
                <RefreshCw className={`h-4 w-4 mr-2 ${resendMutation.isPending ? "animate-spin" : ""}`} />
                {resendMutation.isPending ? "Resending..." : "Resend Invitations"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDeleteDialogOpen(true)}
              data-testid="button-delete-envelope"
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        </div>

        <Tabs defaultValue="overview" className="w-full">
          <TabsList data-testid="tabs-envelope-detail">
            <TabsTrigger value="overview" data-testid="tab-overview">
              <FileText className="h-3.5 w-3.5 mr-1.5" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="signers" data-testid="tab-signers">
              <Users className="h-3.5 w-3.5 mr-1.5" />
              Signers
            </TabsTrigger>
            <TabsTrigger value="communication" data-testid="tab-communication">
              <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
              Communication
              {envelope.communicationLogs?.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-xs">{envelope.communicationLogs.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="audit" data-testid="tab-audit">
              <Shield className="h-3.5 w-3.5 mr-1.5" />
              Audit Trail
            </TabsTrigger>
            <TabsTrigger value="certificate" data-testid="tab-certificate">
              <Award className="h-3.5 w-3.5 mr-1.5" />
              Certificate
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4 space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <Card>
                <CardContent className="p-5 space-y-3">
                  <h3 className="font-medium text-sm">Document Info</h3>
                  <Separator />
                  <InfoRow label="Subject" value={envelope.subject} />
                  <InfoRow label="Reference" value={envelope.externalRef || "—"} />
                  <InfoRow label="Total Pages" value={String(envelope.totalPages)} />
                  <InfoRow label="Status" value={config.label} />
                  {envelope.webhookUrl && <InfoRow label="Webhook" value={envelope.webhookUrl} />}
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-5 space-y-3">
                  <h3 className="font-medium text-sm">Timeline</h3>
                  <Separator />
                  <InfoRow label="Created" value={format(new Date(envelope.createdAt), "PPp")} />
                  <InfoRow label="Last Updated" value={format(new Date(envelope.updatedAt), "PPp")} />
                  {envelope.signers?.some(s => s.lastViewedAt) && (
                    <InfoRow label="Last Viewed" value={format(new Date(envelope.signers.find(s => s.lastViewedAt)!.lastViewedAt!), "PPp")} />
                  )}
                  {envelope.signers?.some(s => s.signedAt) && (
                    <InfoRow label="Signed" value={format(new Date(envelope.signers.find(s => s.signedAt)!.signedAt!), "PPp")} />
                  )}
                </CardContent>
              </Card>
            </div>
            {envelope.originalPdfUrl && (
              <Card>
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">Original PDF</span>
                    </div>
                    <a href={envelope.originalPdfUrl} target="_blank" rel="noopener noreferrer">
                      <Button variant="outline" size="sm" data-testid="button-view-original-pdf">
                        <ExternalLink className="h-3 w-3 mr-1.5" />
                        Open in New Tab
                      </Button>
                    </a>
                  </div>
                  <iframe
                    src={envelope.originalPdfUrl}
                    className="w-full border rounded-md"
                    style={{ height: "500px" }}
                    title="Document preview"
                    data-testid="pdf-preview"
                  />
                </CardContent>
              </Card>
            )}
            {envelope.signedPdfUrl && (
              <Card>
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                      <span className="text-sm font-medium">Signed PDF</span>
                    </div>
                    <a href={envelope.signedPdfUrl} target="_blank" rel="noopener noreferrer">
                      <Button variant="outline" size="sm" data-testid="button-view-signed-pdf">
                        <ExternalLink className="h-3 w-3 mr-1.5" />
                        Open in New Tab
                      </Button>
                    </a>
                  </div>
                  <iframe
                    src={envelope.signedPdfUrl}
                    className="w-full border rounded-md"
                    style={{ height: "500px" }}
                    title="Signed document preview"
                    data-testid="signed-pdf-preview"
                  />
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="signers" className="mt-4 space-y-3">
            {envelope.signers?.map((signer) => (
              <Card key={signer.id}>
                <CardContent className="p-5">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium" data-testid={`text-signer-name-${signer.id}`}>{signer.fullName}</p>
                        {isSharedInbox(sharedEmailMap, signer.email) && (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 border-amber-500/60 text-amber-700 dark:text-amber-400"
                            data-testid={`badge-shared-inbox-${signer.id}`}
                            title="Multiple active contacts share this inbox — verify the signer name is correct"
                          >
                            <UsersIcon className="h-2.5 w-2.5 mr-0.5" />
                            shared inbox
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">{signer.email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {signer.signedAt ? (
                        <Badge variant="default">
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          Signed {format(new Date(signer.signedAt), "MMM d")}
                        </Badge>
                      ) : signer.otpVerified ? (
                        <Badge variant="outline">
                          <Eye className="h-3 w-3 mr-1" />
                          Verified
                        </Badge>
                      ) : signer.lastViewedAt ? (
                        <Badge variant="secondary">
                          <Eye className="h-3 w-3 mr-1" />
                          Viewed
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          <Clock className="h-3 w-3 mr-1" />
                          Pending
                        </Badge>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => copySigningLink(signer.accessToken)}
                        data-testid={`button-copy-link-${signer.id}`}
                      >
                        <Copy className="h-3 w-3 mr-1.5" />
                        Copy Link
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => toggleReveal(signer.id)}
                        data-testid={`button-toggle-creds-${signer.id}`}
                      >
                        {revealedCreds[signer.id] ? (
                          <><EyeOff className="h-3 w-3 mr-1.5" />Hide credentials</>
                        ) : (
                          <><KeyRound className="h-3 w-3 mr-1.5" />Reveal credentials</>
                        )}
                      </Button>
                    </div>
                  </div>

                  {revealedCreds[signer.id] && (
                    <div className="mt-4 pt-4 border-t space-y-3">
                      <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50">
                        <Shield className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                        <p className="text-xs text-amber-900 dark:text-amber-200">
                          The access token is a bearer credential. Anyone with this token can sign as this signer until the envelope is completed. Share only over a secure channel.
                        </p>
                      </div>

                      <CredentialRow
                        label="Access URL"
                        value={`${window.location.origin}/sign/${signer.accessToken}`}
                        signerId={signer.id}
                        field="accessUrl"
                        onCopy={copyValue}
                        mono
                      />
                      <CredentialRow
                        label="Access Token"
                        value={signer.accessToken}
                        signerId={signer.id}
                        field="accessToken"
                        onCopy={copyValue}
                        mono
                        sensitive
                      />
                      <CredentialRow
                        label="OTP Destination"
                        value={signer.email}
                        signerId={signer.id}
                        field="otpDestination"
                        onCopy={copyValue}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </TabsContent>

          <TabsContent value="communication" className="mt-4 space-y-4">
            {envelope.communicationLogs?.length > 0 ? (
              <div className="space-y-3">
                {envelope.communicationLogs.map((log) => (
                  <Card key={log.id}>
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className={`flex h-8 w-8 items-center justify-center rounded-md flex-shrink-0 ${log.isExternalQuery ? "bg-destructive/10" : "bg-primary/10"}`}>
                          <MessageSquare className={`h-4 w-4 ${log.isExternalQuery ? "text-destructive" : "text-primary"}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium">{log.senderEmail}</span>
                            {log.isExternalQuery && <Badge variant="destructive" className="text-xs">Query</Badge>}
                            <span className="text-xs text-muted-foreground">{format(new Date(log.timestamp), "PPp")}</span>
                          </div>
                          <p className="text-sm mt-1 text-muted-foreground whitespace-pre-wrap">{log.messageBody}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <MessageSquare className="h-10 w-10 text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">No communication yet</p>
              </div>
            )}

            {envelope.status === "queried" && (
              <Card>
                <CardContent className="p-4 space-y-3">
                  <h4 className="text-sm font-medium">Reply to Query</h4>
                  <Textarea
                    placeholder="Type your response to the signer's query..."
                    value={replyMessage}
                    onChange={(e) => setReplyMessage(e.target.value)}
                    className="resize-none"
                    rows={3}
                    data-testid="input-reply-message"
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      onClick={() => replyMutation.mutate(replyMessage)}
                      disabled={!replyMessage.trim() || replyMutation.isPending}
                      data-testid="button-send-reply"
                    >
                      <Send className="h-3 w-3 mr-1.5" />
                      {replyMutation.isPending ? "Sending..." : "Send Reply"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="audit" className="mt-4">
            {envelope.auditEvents?.length > 0 ? (
              <Card>
                <CardContent className="p-0">
                  <div className="divide-y">
                    {envelope.auditEvents.map((event) => (
                      <div key={event.id} className="flex items-center gap-3 p-4">
                        <div className="flex h-2 w-2 rounded-full bg-primary flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm">{event.eventType}</p>
                          {event.actorEmail && <p className="text-xs text-muted-foreground">{event.actorEmail}</p>}
                        </div>
                        <span className="text-xs text-muted-foreground flex-shrink-0">
                          {format(new Date(event.timestamp), "PPp")}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Shield className="h-10 w-10 text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">No audit events yet</p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="certificate" className="mt-4">
            <CertificatePanel envelope={envelope} />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={deleteDialogOpen} onOpenChange={(open) => { setDeleteDialogOpen(open); if (!open) setDeleteReason(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Envelope</DialogTitle>
            <DialogDescription>
              This will move the envelope to deleted items. Please provide a reason for this deletion — it will be recorded in the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="delete-reason">Reason for deletion</Label>
            <Textarea
              id="delete-reason"
              placeholder="e.g. Duplicate envelope, client cancelled project, incorrect document..."
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              className="min-h-[100px]"
              data-testid="input-delete-reason"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setDeleteDialogOpen(false); setDeleteReason(""); }} data-testid="button-cancel-delete">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate(deleteReason)}
              disabled={deleteReason.trim().length === 0 || deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {deleteMutation.isPending ? "Deleting..." : "Delete Envelope"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resendDialogOpen} onOpenChange={(open) => { setResendDialogOpen(open); if (!open) setResendMessage(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resend Invitations</DialogTitle>
            <DialogDescription>
              Reminder emails will be sent to all pending signers. You can optionally include a short message that will appear in the reminder email.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="resend-message">Optional message</Label>
            <Textarea
              id="resend-message"
              placeholder="e.g. Just a friendly reminder — please sign by Friday."
              value={resendMessage}
              onChange={(e) => setResendMessage(e.target.value)}
              className="min-h-[100px]"
              data-testid="input-resend-message"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setResendDialogOpen(false); setResendMessage(""); }} data-testid="button-cancel-resend">
              Cancel
            </Button>
            <Button
              onClick={() => resendMutation.mutate(resendMessage)}
              disabled={resendMutation.isPending}
              data-testid="button-confirm-resend"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${resendMutation.isPending ? "animate-spin" : ""}`} />
              {resendMutation.isPending ? "Resending..." : "Resend Invitations"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm text-muted-foreground flex-shrink-0">{label}</span>
      <span className="text-sm text-right break-all">{value}</span>
    </div>
  );
}

interface CertificatePanelProps {
  envelope: EnvelopeDetail;
}

function DownloadCertificateButton({ envelopeId }: { envelopeId: number }) {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);
  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`/api/envelopes/${envelopeId}/certificate.pdf`, {
        credentials: "include",
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        throw new Error(msg || `Download failed (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `certificate_envelope_${envelopeId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({
        title: "Could not download certificate",
        description: err?.message || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setDownloading(false);
    }
  };
  return (
    <Button
      variant="default"
      size="sm"
      onClick={handleDownload}
      disabled={downloading}
      data-testid="button-download-certificate"
    >
      <Download className="h-3 w-3 mr-1.5" />
      {downloading ? "Preparing..." : "Download certificate"}
    </Button>
  );
}

function fmtTs(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  // Render in true UTC so the "UTC" label matches the value. date-fns/format
  // would otherwise emit the local timezone with a misleading "UTC" suffix.
  return dt.toISOString().replace("T", " ").replace(/\..*$/, " UTC");
}

function deriveMilestones(env: EnvelopeDetail) {
  const events = [...(env.auditEvents || [])].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const match = (re: RegExp) => events.find((e) => re.test(e.eventType));
  const sentEvt = match(/sent|invitation/i);
  const deliveredEvt = match(/deliver/i);
  const completedEvt = match(/complete/i);
  const otpVerifiedSigner = env.signers
    .filter((s) => s.otpVerifiedAt)
    .sort(
      (a, b) =>
        new Date(a.otpVerifiedAt!).getTime() - new Date(b.otpVerifiedAt!).getTime(),
    )[0];
  const lastSignedSigner = env.signers
    .filter((s) => s.signedAt)
    .sort(
      (a, b) => new Date(b.signedAt!).getTime() - new Date(a.signedAt!).getTime(),
    )[0];
  return [
    { label: "Sent", timestamp: sentEvt?.timestamp ?? env.createdAt, actor: sentEvt?.actorEmail || "—" },
    { label: "Delivered", timestamp: deliveredEvt?.timestamp ?? null, actor: deliveredEvt?.actorEmail || "—" },
    {
      label: "OTP verified",
      timestamp: otpVerifiedSigner?.otpVerifiedAt ?? null,
      actor: otpVerifiedSigner?.email || "—",
    },
    {
      label: "Signed",
      timestamp: lastSignedSigner?.signedAt ?? null,
      actor: lastSignedSigner?.email || "—",
    },
    {
      label: "Completed",
      timestamp:
        (completedEvt?.timestamp ?? null) ||
        (lastSignedSigner?.signedAt ?? null),
      actor: completedEvt?.actorEmail || lastSignedSigner?.email || "—",
    },
  ];
}

function CertificatePanel({ envelope }: CertificatePanelProps) {
  // A certificate is only "available" for envelopes whose signed PDF was
  // produced by the certificate-appending pipeline. We use documentHash as
  // the marker because it is populated atomically with signed_pdf_url by the
  // signing route; legacy envelopes signed before this feature have a
  // signed PDF but no hash, so they correctly fall into the empty state.
  const hasCert = !!envelope.documentHash;
  // Certificate of *Completion* — only meaningful once every signer has
  // signed. Partially-signed envelopes must NOT expose a download button or
  // they'd produce a certificate that misrepresents the envelope state.
  const allSigned =
    (envelope.signers?.length ?? 0) > 0 &&
    envelope.signers.every((s) => !!s.signedAt);
  if (!hasCert) {
    return (
      <div
        className="flex flex-col items-center justify-center py-12 text-center"
        data-testid="certificate-empty"
      >
        <Award className="h-10 w-10 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No certificate available</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          {envelope.signedPdfUrl
            ? "This envelope was signed before completion certificates were generated. The certificate can still be regenerated from the recorded audit trail."
            : "A completion certificate is generated once all signers have signed."}
        </p>
        <div className="mt-3 flex items-center gap-2 flex-wrap justify-center">
          {envelope.signedPdfUrl && (
            <a href={envelope.signedPdfUrl} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm" data-testid="button-open-signed-pdf-legacy">
                <ExternalLink className="h-3 w-3 mr-1.5" />
                Open signed PDF
              </Button>
            </a>
          )}
          {allSigned && <DownloadCertificateButton envelopeId={envelope.id} />}
        </div>
      </div>
    );
  }

  const milestones = deriveMilestones(envelope);
  const latestSignedAtMs = envelope.signers
    .map((s) => (s.signedAt ? new Date(s.signedAt).getTime() : 0))
    .reduce((a, b) => Math.max(a, b), 0);
  const completedAt = latestSignedAtMs ? new Date(latestSignedAtMs) : null;
  const eventsAsc = [...(envelope.auditEvents || [])].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return (
    <div className="space-y-4" data-testid="certificate-panel">
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h3 className="font-semibold text-base flex items-center gap-2">
                <Award className="h-4 w-4 text-primary" />
                Certificate of Completion
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Mirrors the certificate page appended to the signed PDF.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <a href={envelope.signedPdfUrl!} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm" data-testid="button-open-signed-pdf-cert">
                  <ExternalLink className="h-3 w-3 mr-1.5" />
                  Open signed PDF
                </Button>
              </a>
              <DownloadCertificateButton envelopeId={envelope.id} />
            </div>
          </div>
          <Separator />
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
            <InfoRow label="Envelope ID" value={String(envelope.id)} />
            <InfoRow label="Status" value={envelope.status} />
            <InfoRow label="Subject" value={envelope.subject} />
            <InfoRow label="Origin" value={envelope.origin || "local"} />
            <InfoRow label="External Ref" value={envelope.externalRef || "—"} />
            <InfoRow label="Document Pages" value={String(envelope.totalPages)} />
            <InfoRow label="Created" value={fmtTs(envelope.createdAt)} />
            <InfoRow label="Completed" value={fmtTs(completedAt)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-3">
          <h3 className="font-medium text-sm">Milestones</h3>
          <Separator />
          <div className="divide-y">
            {milestones.map((m) => (
              <div
                key={m.label}
                className="grid grid-cols-[120px_1fr_auto] gap-3 py-2 text-sm items-center"
                data-testid={`cert-milestone-${m.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <span className="font-medium">{m.label}</span>
                <span className="text-muted-foreground truncate" title={m.actor}>
                  {m.actor}
                </span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {fmtTs(m.timestamp)}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-3">
          <h3 className="font-medium text-sm">Signer Identity Evidence</h3>
          <Separator />
          <div className="space-y-4">
            {envelope.signers.map((s) => (
              <div
                key={s.id}
                className="rounded-md border p-3 space-y-2"
                data-testid={`cert-signer-${s.id}`}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <p className="font-medium text-sm" data-testid={`cert-signer-name-${s.id}`}>
                      {s.fullName}
                    </p>
                    <p className="text-xs text-muted-foreground">{s.email}</p>
                  </div>
                  {s.signedAt ? (
                    <Badge variant="default">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Signed
                    </Badge>
                  ) : (
                    <Badge variant="secondary">
                      <Clock className="h-3 w-3 mr-1" />
                      Pending
                    </Badge>
                  )}
                </div>
                <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                  <InfoRow label="Security level" value="Email + tokenised link, OTP verified" />
                  <InfoRow label="Last viewed" value={fmtTs(s.lastViewedAt)} />
                  <InfoRow label="OTP issued" value={fmtTs(s.otpIssuedAt)} />
                  <InfoRow label="OTP verified" value={fmtTs(s.otpVerifiedAt)} />
                  <InfoRow label="Signed" value={fmtTs(s.signedAt)} />
                  <InfoRow label="IP address" value={s.signerIpAddress || "—"} />
                  <div className="sm:col-span-2">
                    <InfoRow
                      label="User agent"
                      value={s.signerUserAgent || "—"}
                    />
                  </div>
                </div>
                {s.signedAt && (
                  <p className="text-xs text-muted-foreground italic pt-1">
                    Signer typed their name; Archisign rendered it as their signature graphic,
                    which the signer adopted as their electronic signature.
                  </p>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-3">
          <h3 className="font-medium text-sm">Envelope Audit Timeline</h3>
          <Separator />
          {eventsAsc.length === 0 ? (
            <p className="text-sm text-muted-foreground">No audit events recorded.</p>
          ) : (
            <div className="divide-y">
              {eventsAsc.map((ev) => (
                <div
                  key={ev.id}
                  className="grid grid-cols-[1fr_auto] gap-3 py-2 text-sm items-center"
                  data-testid={`cert-audit-${ev.id}`}
                >
                  <div className="min-w-0">
                    <p className="truncate">{ev.eventType}</p>
                    {ev.actorEmail && (
                      <p className="text-xs text-muted-foreground truncate">
                        {ev.actorEmail}
                        {ev.ipAddress ? ` · ${ev.ipAddress}` : ""}
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {fmtTs(ev.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-3">
          <h3 className="font-medium text-sm flex items-center gap-2">
            <Fingerprint className="h-4 w-4 text-muted-foreground" />
            Document Integrity
          </h3>
          <Separator />
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">SHA-256 (signed body)</Label>
            <code
              className="block break-all text-xs font-mono px-3 py-2 rounded-md bg-muted select-all"
              data-testid="cert-document-hash"
            >
              {envelope.documentHash}
            </code>
            <p className="text-xs text-muted-foreground pt-1">
              This certificate is bound to the signed document by the hash above. Any
              modification to the signed body invalidates this hash.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
