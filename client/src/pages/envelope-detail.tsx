import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  ArrowLeft, Send, Copy, ExternalLink, FileText, Eye, Clock,
  AlertTriangle, CheckCircle2, MessageSquare, Shield, Users
} from "lucide-react";
import type { Envelope, Signer, CommunicationLog, AuditEvent } from "@shared/schema";
import { format } from "date-fns";
import { useState } from "react";

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

export default function EnvelopeDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [replyMessage, setReplyMessage] = useState("");

  const { data: envelope, isLoading } = useQuery<EnvelopeDetail>({
    queryKey: ["/api/envelopes", id],
    enabled: !!id,
  });

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
              <Button onClick={() => sendMutation.mutate()} disabled={sendMutation.isPending} data-testid="button-send-envelope">
                <Send className="h-4 w-4 mr-2" />
                {sendMutation.isPending ? "Sending..." : "Send for Signing"}
              </Button>
            )}
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
                      <p className="font-medium" data-testid={`text-signer-name-${signer.id}`}>{signer.fullName}</p>
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
                    </div>
                  </div>
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
        </Tabs>
      </div>
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
