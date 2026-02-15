import { useState, useCallback } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2, PenTool, AlertTriangle, MessageSquare, ChevronLeft, ChevronRight,
  FileText, Lock, ShieldCheck
} from "lucide-react";
import type { Signer, Envelope } from "@shared/schema";

type DocumentInfo = {
  envelope: Envelope;
  signer: Signer;
  totalPages: number;
  initialed: number[];
};

export default function SignerDocument() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  const [currentPage, setCurrentPage] = useState(1);
  const [queryDialogOpen, setQueryDialogOpen] = useState(false);
  const [queryMessage, setQueryMessage] = useState("");
  const [signDialogOpen, setSignDialogOpen] = useState(false);

  const { data: docInfo, isLoading, refetch } = useQuery<DocumentInfo>({
    queryKey: ["/api/sign", token, "document"],
    queryFn: async () => {
      const res = await fetch(`/api/sign/${token}/document`);
      if (!res.ok) throw new Error("Unable to load document");
      return res.json();
    },
    enabled: !!token,
  });

  const initialMutation = useMutation({
    mutationFn: async (pageNumber: number) => {
      const res = await fetch(`/api/sign/${token}/initial`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageNumber }),
      });
      if (!res.ok) throw new Error("Failed to add initial");
      return res.json();
    },
    onSuccess: () => {
      refetch();
    },
  });

  const queryMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch(`/api/sign/${token}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error("Failed to send query");
      return res.json();
    },
    onSuccess: () => {
      setQueryDialogOpen(false);
      setQueryMessage("");
      refetch();
      toast({ title: "Query sent", description: "Your clarification request has been sent to the architect." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const signMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/sign/${token}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to sign document");
      return res.json();
    },
    onSuccess: () => {
      refetch();
      setSignDialogOpen(false);
      toast({ title: "Document signed", description: "The document has been signed successfully." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-4">
        <div className="max-w-4xl mx-auto space-y-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-[600px] w-full" />
        </div>
      </div>
    );
  }

  if (!docInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-4">
            <Lock className="h-12 w-12 text-muted-foreground/40 mx-auto" />
            <h2 className="text-lg font-semibold">Access Denied</h2>
            <p className="text-sm text-muted-foreground">Please verify your identity first.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (docInfo.signer.signedAt) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/20 mx-auto">
              <ShieldCheck className="h-8 w-8 text-green-600 dark:text-green-400" />
            </div>
            <h2 className="text-xl font-semibold">Document Signed</h2>
            <p className="text-sm text-muted-foreground">
              You have successfully signed "{docInfo.envelope.subject}". A copy of the signed document will be emailed to you.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const totalPages = docInfo.totalPages;
  const initialedPages = docInfo.initialed || [];
  const isCurrentPageInitialed = initialedPages.includes(currentPage);
  const allPagesInitialed = totalPages > 0 && initialedPages.length >= totalPages;
  const canSign = allPagesInitialed;

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3 p-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <FileText className="h-5 w-5 text-primary flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-sm font-semibold truncate" data-testid="text-doc-subject">{docInfo.envelope.subject}</h1>
              <p className="text-xs text-muted-foreground">Signing as {docInfo.signer.fullName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" data-testid="badge-initial-progress">
              {initialedPages.length}/{totalPages} initialed
            </Badge>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
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
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            data-testid="button-next-page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            <div className="relative bg-muted rounded-md overflow-hidden" style={{ minHeight: "600px" }}>
              {docInfo.envelope.originalPdfUrl ? (
                <iframe
                  src={`${docInfo.envelope.originalPdfUrl}#page=${currentPage}`}
                  className="w-full border-0 rounded-md"
                  style={{ height: "700px" }}
                  title={`Document page ${currentPage}`}
                  data-testid="pdf-viewer"
                />
              ) : (
                <div className="flex items-center justify-center h-full min-h-[600px] p-8">
                  <div className="text-center space-y-4">
                    <FileText className="h-16 w-16 text-muted-foreground/20 mx-auto" />
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Page {currentPage}</p>
                      <p className="text-xs text-muted-foreground/60 mt-1">No PDF document attached</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="absolute bottom-4 right-4">
                {isCurrentPageInitialed ? (
                  <Badge variant="default" className="gap-1" data-testid={`badge-initialed-page-${currentPage}`}>
                    <CheckCircle2 className="h-3 w-3" />
                    Initialed
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => initialMutation.mutate(currentPage)}
                    disabled={initialMutation.isPending}
                    data-testid={`button-initial-page-${currentPage}`}
                  >
                    <PenTool className="h-3.5 w-3.5 mr-1.5" />
                    {initialMutation.isPending ? "Adding..." : "Initial This Page"}
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-1.5 flex-wrap justify-center">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
            <Button
              key={page}
              variant={page === currentPage ? "default" : initialedPages.includes(page) ? "outline" : "secondary"}
              size="sm"
              className="w-9"
              onClick={() => setCurrentPage(page)}
              data-testid={`button-page-${page}`}
            >
              {initialedPages.includes(page) ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : (
                page
              )}
            </Button>
          ))}
        </div>

        {!allPagesInitialed && (
          <div className="flex items-center gap-2 p-3 rounded-md bg-muted text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            <span>Please initial all {totalPages} pages before signing. {totalPages - initialedPages.length} pages remaining.</span>
          </div>
        )}

        <div className="h-24" />
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background/95 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3 p-4 flex-wrap">
          <Button
            variant="outline"
            onClick={() => setQueryDialogOpen(true)}
            data-testid="button-request-clarification"
          >
            <MessageSquare className="h-4 w-4 mr-2" />
            Request Clarification
          </Button>
          <Button
            size="lg"
            disabled={!canSign}
            onClick={() => setSignDialogOpen(true)}
            className="bg-[#F97316] border-[#F97316] text-white font-semibold text-base px-8 shadow-lg"
            data-testid="button-final-sign"
          >
            <PenTool className="h-5 w-5 mr-2" />
            Sign Document
          </Button>
        </div>
      </div>

      <Dialog open={queryDialogOpen} onOpenChange={setQueryDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Clarification</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Send a message to the architect about this document. They will respond via email.
            </p>
            <Textarea
              placeholder="Describe your question or concern about the document..."
              value={queryMessage}
              onChange={(e) => setQueryMessage(e.target.value)}
              className="resize-none"
              rows={4}
              data-testid="input-query-message"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setQueryDialogOpen(false)} data-testid="button-cancel-query">
              Cancel
            </Button>
            <Button
              onClick={() => queryMutation.mutate(queryMessage)}
              disabled={!queryMessage.trim() || queryMutation.isPending}
              data-testid="button-send-query"
            >
              {queryMutation.isPending ? "Sending..." : "Send Query"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={signDialogOpen} onOpenChange={setSignDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Signature</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              You are about to sign "{docInfo.envelope.subject}". This action is legally binding and cannot be undone.
            </p>
            <div className="p-4 rounded-md bg-muted space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Document</span>
                <span className="font-medium">{docInfo.envelope.subject}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Signer</span>
                <span className="font-medium">{docInfo.signer.fullName}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Pages Initialed</span>
                <span className="font-medium">{initialedPages.length}/{totalPages}</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSignDialogOpen(false)} data-testid="button-cancel-sign">
              Cancel
            </Button>
            <Button
              onClick={() => signMutation.mutate()}
              disabled={signMutation.isPending}
              data-testid="button-confirm-sign"
            >
              <PenTool className="h-4 w-4 mr-2" />
              {signMutation.isPending ? "Signing..." : "Sign Document"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
