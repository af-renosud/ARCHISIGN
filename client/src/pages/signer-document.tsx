import { useState, useEffect, useCallback, useRef } from "react";
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
  CheckCircle2, PenTool, MessageSquare, ChevronLeft, ChevronRight,
  FileText, Lock, ShieldCheck, Download
} from "lucide-react";
import type { Signer, Envelope } from "@shared/schema";

interface PlacedField {
  id: number;
  type: "initial" | "signature" | "date";
  pageNumber: number;
  xPos: number;
  yPos: number;
  width: number | null;
  height: number | null;
}

type DocumentInfo = {
  envelope: Envelope;
  signer: Signer & { authenticationId?: string | null };
  totalPages: number;
  initialed: number[];
  placedFields?: PlacedField[];
};

function StepperProgress({ currentStep, totalSteps, initialedPages }: {
  currentStep: number;
  totalSteps: number;
  initialedPages: number[];
}) {
  return (
    <div className="flex items-center gap-1 w-full overflow-x-auto py-1" data-testid="stepper-progress">
      {Array.from({ length: totalSteps }, (_, i) => {
        const stepNum = i + 1;
        const isPageStep = stepNum <= totalSteps - 1;
        const isComplete = isPageStep ? initialedPages.includes(stepNum) : false;
        const isCurrent = stepNum === currentStep;

        return (
          <div key={stepNum} className="flex items-center gap-1 flex-shrink-0">
            {i > 0 && (
              <div className={`h-0.5 w-4 sm:w-6 ${isComplete || (stepNum <= currentStep && !isPageStep) ? "bg-primary" : "bg-muted-foreground/20"}`} />
            )}
            <div
              className={`flex items-center justify-center rounded-full text-xs font-medium transition-all
                ${isCurrent
                  ? "h-7 w-7 ring-2 ring-primary ring-offset-2 ring-offset-background bg-primary text-primary-foreground"
                  : isComplete
                    ? "h-6 w-6 bg-primary text-primary-foreground"
                    : "h-6 w-6 bg-muted text-muted-foreground"
                }`}
              data-testid={`stepper-dot-${stepNum}`}
            >
              {isComplete ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : isPageStep ? (
                stepNum
              ) : (
                <PenTool className="h-3 w-3" />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function SignerDocument() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  const [wizardStep, setWizardStep] = useState(1);
  const [queryDialogOpen, setQueryDialogOpen] = useState(false);
  const [queryMessage, setQueryMessage] = useState("");
  const [signDialogOpen, setSignDialogOpen] = useState(false);
  const hasRestoredStep = useRef(false);

  const { data: docInfo, isLoading, refetch } = useQuery<DocumentInfo>({
    queryKey: ["/api/sign", token, "document"],
    queryFn: async () => {
      const res = await fetch(`/api/sign/${token}/document`);
      if (!res.ok) throw new Error("Unable to load document");
      return res.json();
    },
    enabled: !!token,
  });

  const totalPages = docInfo?.totalPages ?? 0;
  const initialedPages = docInfo?.initialed ?? [];
  const placedFields = docInfo?.placedFields ?? [];
  const totalSteps = totalPages + 1;
  const isFinalStep = wizardStep > totalPages;
  const currentPage = isFinalStep ? totalPages : wizardStep;
  const isCurrentPageInitialed = initialedPages.includes(currentPage);
  const allPagesInitialed = totalPages > 0 && initialedPages.length >= totalPages;
  const canSign = allPagesInitialed;

  const currentPageInitialField = placedFields.find(
    f => f.type === "initial" && f.pageNumber === currentPage
  );
  const currentPageSignatureField = placedFields.find(
    f => f.type === "signature" && f.pageNumber === currentPage
  );

  const findNextUninitialed = useCallback((afterPage: number, pages: number[]) => {
    for (let p = afterPage + 1; p <= totalPages; p++) {
      if (!pages.includes(p)) return p;
    }
    return null;
  }, [totalPages]);

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
    onSuccess: (_data, pageNumber) => {
      refetch().then((result) => {
        if (!result.data) return;
        const updatedInitialed = result.data.initialed || [];
        const updatedAllDone = updatedInitialed.length >= totalPages;

        if (updatedAllDone) {
          setWizardStep(totalPages + 1);
        } else {
          const next = findNextUninitialed(pageNumber, updatedInitialed);
          if (next) {
            setWizardStep(next);
          } else {
            const firstUninitialed = findNextUninitialed(0, updatedInitialed);
            if (firstUninitialed) setWizardStep(firstUninitialed);
          }
        }
      });
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

  useEffect(() => {
    if (hasRestoredStep.current) return;
    if (!docInfo || docInfo.signer.signedAt || totalPages === 0) return;

    if (initialedPages.length > 0) {
      hasRestoredStep.current = true;
      if (allPagesInitialed) {
        setWizardStep(totalPages + 1);
      } else {
        const firstUninitialed = findNextUninitialed(0, initialedPages);
        if (firstUninitialed) {
          setWizardStep(firstUninitialed);
        }
      }
    } else if (docInfo) {
      hasRestoredStep.current = true;
    }
  }, [docInfo, totalPages, initialedPages, allPagesInitialed, findNextUninitialed]);

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
    const signedDate = new Date(docInfo.signer.signedAt);
    const formattedDate = signedDate.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const authId = docInfo.signer.authenticationId || "—";

    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="w-full max-w-lg space-y-6">
          <div className="border-[3px] border-red-600 p-6 space-y-3" data-testid="digital-envelope-box">
            <p
              className="text-2xl italic text-blue-800 dark:text-blue-300"
              style={{ fontFamily: "'Dancing Script', cursive" }}
              data-testid="text-script-signature"
            >
              {docInfo.signer.fullName}
            </p>
            <div className="border-t border-gray-300 pt-2 space-y-0.5">
              <p className="text-xs font-bold text-blue-700 dark:text-blue-400 tracking-wide" data-testid="text-digital-envelope-title">
                DIGITAL ENVELOPE
              </p>
              <p className="text-xs font-semibold text-blue-700 dark:text-blue-400" data-testid="text-signed-by">
                SIGNED BY: {docInfo.signer.fullName.toUpperCase()}
              </p>
              <p className="text-xs font-semibold text-blue-700 dark:text-blue-400" data-testid="text-date-signed">
                DATE: {formattedDate.toUpperCase()}
              </p>
              <p className="text-xs font-semibold text-blue-700 dark:text-blue-400" data-testid="text-auth-id">
                AUTHENTICATION: {authId}
              </p>
            </div>
          </div>

          <Card>
            <CardContent className="p-8 text-center space-y-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/20 mx-auto">
                <ShieldCheck className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <h2 className="text-xl font-semibold">Document Signed</h2>
              <p className="text-sm text-muted-foreground">
                You have successfully signed "{docInfo.envelope.subject}". A signed copy has been sent to your email.
              </p>
              <Button
                onClick={() => window.open(`/api/sign/${token}/download`, "_blank")}
                className="bg-[#16a34a] border-[#16a34a] text-white"
                data-testid="button-download-signed-pdf"
              >
                <Download className="h-4 w-4 mr-2" />
                Download Signed Copy
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const stepLabel = isFinalStep
    ? "Final Step — Sign Document"
    : `Step ${wizardStep} of ${totalSteps} — Review & Initial Page ${currentPage}`;

  const stepInstruction = isFinalStep
    ? "All pages have been reviewed and initialed. You may now sign the document or request clarification."
    : isCurrentPageInitialed
      ? "You have already initialed this page. Use the navigation to continue, or click the next step."
      : "Please review the content on this page. When you are ready, click the initial field on the document to confirm you have read it.";

  const handlePrevStep = () => {
    setWizardStep((s) => Math.max(1, s - 1));
  };

  const handleNextStep = () => {
    if (allPagesInitialed) {
      setWizardStep(totalPages + 1);
    } else {
      setWizardStep((s) => Math.min(totalSteps, s + 1));
    }
  };

  const signerInitials = docInfo.signer.fullName.split(" ").map(n => n[0]).join("").toUpperCase();

  return (
    <div className="min-h-screen bg-background">
      <link
        href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;700&display=swap"
        rel="stylesheet"
      />

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
        <div className="flex justify-center">
          <StepperProgress
            currentStep={wizardStep}
            totalSteps={totalSteps}
            initialedPages={initialedPages}
          />
        </div>

        <div className="rounded-lg border bg-muted/40 px-4 py-3" data-testid="wizard-instruction-box">
          <p className="text-sm font-semibold text-foreground" data-testid="text-step-label">
            {stepLabel}
          </p>
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-step-instruction">
            {stepInstruction}
          </p>
        </div>

        {!isFinalStep && (
          <>
            <div className="flex items-center justify-between gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={handlePrevStep}
                disabled={wizardStep <= 1}
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
                onClick={handleNextStep}
                disabled={wizardStep >= totalSteps}
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

                  {currentPageInitialField && !isCurrentPageInitialed && (
                    <div
                      className="absolute"
                      style={{
                        left: `${currentPageInitialField.xPos * 100}%`,
                        top: `${currentPageInitialField.yPos * 100}%`,
                        width: currentPageInitialField.width ? `${currentPageInitialField.width * 100}%` : "auto",
                      }}
                    >
                      <Button
                        size="sm"
                        onClick={() => initialMutation.mutate(currentPage)}
                        disabled={initialMutation.isPending}
                        className="shadow-lg"
                        data-testid={`button-initial-page-${currentPage}`}
                      >
                        <PenTool className="h-3.5 w-3.5 mr-1.5" />
                        {initialMutation.isPending ? "Adding..." : `Initial [${signerInitials}]`}
                      </Button>
                    </div>
                  )}

                  {currentPageInitialField && isCurrentPageInitialed && (
                    <div
                      className="absolute"
                      style={{
                        left: `${currentPageInitialField.xPos * 100}%`,
                        top: `${currentPageInitialField.yPos * 100}%`,
                      }}
                    >
                      <Badge variant="default" className="gap-1 shadow-sm" data-testid={`badge-initialed-page-${currentPage}`}>
                        <CheckCircle2 className="h-3 w-3" />
                        {signerInitials}
                      </Badge>
                    </div>
                  )}

                  {!currentPageInitialField && (
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
                  )}

                  {currentPageSignatureField && (
                    <div
                      className="absolute border-2 border-dashed border-red-400 rounded-md bg-red-50/30 dark:bg-red-950/20 flex items-center justify-center"
                      style={{
                        left: `${currentPageSignatureField.xPos * 100}%`,
                        top: `${currentPageSignatureField.yPos * 100}%`,
                        width: currentPageSignatureField.width ? `${currentPageSignatureField.width * 100}%` : "25%",
                        height: currentPageSignatureField.height ? `${currentPageSignatureField.height * 100}%` : "8%",
                      }}
                      data-testid="signature-placeholder"
                    >
                      <span className="text-xs text-red-500 font-medium">Sign Here</span>
                    </div>
                  )}
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
                  onClick={() => setWizardStep(page)}
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
          </>
        )}

        {isFinalStep && (
          <Card>
            <CardContent className="p-8 text-center space-y-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/20 mx-auto">
                <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <h2 className="text-xl font-semibold" data-testid="text-ready-to-sign">Ready to Sign</h2>
              <p className="text-sm text-muted-foreground">
                You have reviewed and initialed all {totalPages} pages of "{docInfo.envelope.subject}".
              </p>
              <div className="border-2 border-dashed border-red-400 rounded-lg p-4 mx-auto max-w-sm bg-red-50/30 dark:bg-red-950/20">
                <p className="text-xs text-muted-foreground mb-2">Your signature will appear as:</p>
                <p
                  className="text-2xl text-blue-800 dark:text-blue-300 italic"
                  style={{ fontFamily: "'Dancing Script', cursive" }}
                  data-testid="text-signature-preview"
                >
                  {docInfo.signer.fullName}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Click "Sign Now" below to apply your legally binding signature.
              </p>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2 pb-4" data-testid="action-buttons-row">
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
            Sign Now
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
            <div className="border-2 border-red-500 rounded-lg p-4 bg-white dark:bg-gray-950">
              <p
                className="text-2xl text-blue-800 dark:text-blue-300 italic text-center"
                style={{ fontFamily: "'Dancing Script', cursive" }}
                data-testid="text-confirm-signature-preview"
              >
                {docInfo.signer.fullName}
              </p>
            </div>
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
              className="bg-[#F97316] border-[#F97316] text-white"
              data-testid="button-confirm-sign"
            >
              <PenTool className="h-4 w-4 mr-2" />
              {signMutation.isPending ? "Signing..." : "Sign Now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
