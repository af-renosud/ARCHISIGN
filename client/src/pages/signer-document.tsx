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
  CheckCircle2, PenTool, MessageSquare, ChevronLeft,
  FileText, Lock, ShieldCheck, Download
} from "lucide-react";
import type { Signer, Envelope } from "@shared/schema";
import { LockedPageView } from "@/components/locked-page-view";

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
  const [flowStarted, setFlowStarted] = useState(false);
  const [startConfirmOpen, setStartConfirmOpen] = useState(false);
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

  const signaturePlacementMode = docInfo?.envelope.signaturePlacementMode ?? "fixed_bottom_centre";
  // The locked bottom-centre preview only appears on the last page (where
  // PdfService stamps the signature box). Geometry mirrors PdfService:
  // 25% page width, ≈10mm padding from the page bottom.
  const showFixedBottomPreview =
    signaturePlacementMode === "fixed_bottom_centre" && currentPage === totalPages && totalPages > 0;

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
      // Signer has resumed mid-flow — bypass the Start gate, they're already in.
      setFlowStarted(true);
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

  const confirmStart = () => {
    setStartConfirmOpen(false);
    setFlowStarted(true);
    const firstUninitialed = findNextUninitialed(0, initialedPages) ?? 1;
    setWizardStep(firstUninitialed);
  };

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
      ? "You have already initialed this page. The next page will open automatically; use Previous to revisit an earlier initialed page."
      : "Please review the content on this page, then click the initial field on the document. The next page will open automatically — there is no forward skip.";

  // Back is only allowed to a page the signer has already initialed (rigid flow:
  // forward skipping is forbidden, but the signer may revisit a previously initialed page).
  const prevInitialedPage = (() => {
    for (let p = wizardStep - 1; p >= 1; p--) {
      if (initialedPages.includes(p)) return p;
    }
    return null;
  })();
  const handlePrevStep = () => {
    if (prevInitialedPage !== null) setWizardStep(prevInitialedPage);
  };

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
        <div
          className="rounded-lg border-2 border-primary/40 bg-primary/5 px-4 py-3 text-center"
          data-testid="banner-top-instructions"
        >
          <p className="text-sm sm:text-base font-semibold text-foreground">
            Review the document first and when you are ready to proceed click start. Initial each page first, then sign at the end.
          </p>
        </div>

        {!flowStarted && (
          <div className="space-y-4" data-testid="review-mode-container">
            <Card>
              <CardContent className="p-0">
                {docInfo.envelope.originalPdfUrl ? (
                  <iframe
                    src={docInfo.envelope.originalPdfUrl}
                    className="w-full border-0 rounded-md"
                    style={{ height: "75vh", minHeight: "600px" }}
                    title="Document review"
                    data-testid="pdf-viewer-review"
                  />
                ) : (
                  <div className="flex items-center justify-center min-h-[600px] p-8">
                    <div className="text-center space-y-4">
                      <FileText className="h-16 w-16 text-muted-foreground/20 mx-auto" />
                      <p className="text-sm text-muted-foreground">No PDF document attached</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2 pb-4">
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
                onClick={() => setStartConfirmOpen(true)}
                className="bg-[#F97316] border-[#F97316] text-white font-semibold text-base px-8 shadow-lg"
                data-testid="button-start-signing"
              >
                <PenTool className="h-5 w-5 mr-2" />
                Start
              </Button>
            </div>
          </div>
        )}

        {flowStarted && (
          <>
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
                    disabled={prevInitialedPage === null}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous initialed page
                  </Button>
                  <span className="text-sm text-muted-foreground" data-testid="text-page-indicator">
                    Page {currentPage} of {totalPages}
                  </span>
                  <span className="text-xs text-muted-foreground italic">
                    Initial to advance
                  </span>
                </div>

                <Card>
                  <CardContent className="p-2 sm:p-4">
                    {docInfo.envelope.originalPdfUrl ? (
                      <LockedPageView
                        pdfUrl={docInfo.envelope.originalPdfUrl}
                        pageNumber={currentPage}
                        fields={placedFields.filter(f => f.pageNumber === currentPage)}
                        signerFullName={docInfo.signer.fullName}
                        initialPlaced={isCurrentPageInitialed}
                        signaturePlaced={false}
                        showFixedBottomSignaturePlaceholder={false}
                        onClickInitial={() => initialMutation.mutate(currentPage)}
                        initialPending={initialMutation.isPending}
                      />
                    ) : (
                      <div className="flex items-center justify-center min-h-[600px] p-8 bg-muted rounded-md">
                        <div className="text-center space-y-4">
                          <FileText className="h-16 w-16 text-muted-foreground/20 mx-auto" />
                          <div>
                            <p className="text-sm font-medium text-muted-foreground">Page {currentPage}</p>
                            <p className="text-xs text-muted-foreground/60 mt-1">No PDF document attached</p>
                          </div>
                        </div>
                      </div>
                    )}

                    {!currentPageInitialField && docInfo.envelope.originalPdfUrl && (
                      <div className="flex justify-end mt-3">
                        {isCurrentPageInitialed ? (
                          <Badge variant="default" className="gap-1" data-testid={`badge-initialed-page-${currentPage}`}>
                            <CheckCircle2 className="h-3 w-3" />
                            Page initialed
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
                  </CardContent>
                </Card>
              </>
            )}

            {isFinalStep && (
              <>
                <div className="rounded-lg border border-green-200 dark:border-green-900 bg-green-50/60 dark:bg-green-950/20 px-4 py-3 flex items-center gap-3" data-testid="banner-ready-to-sign">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40 flex-shrink-0">
                    <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold" data-testid="text-ready-to-sign">Ready to Sign</p>
                    <p className="text-xs text-muted-foreground">
                      Click the signature box on page {totalPages} below — or use Sign Now at the bottom.
                    </p>
                  </div>
                </div>

                <Card>
                  <CardContent className="p-2 sm:p-4">
                    {docInfo.envelope.originalPdfUrl ? (
                      <LockedPageView
                        pdfUrl={docInfo.envelope.originalPdfUrl}
                        pageNumber={totalPages}
                        fields={placedFields.filter(
                          f => f.pageNumber === totalPages && f.type === "signature",
                        )}
                        signerFullName={docInfo.signer.fullName}
                        initialPlaced={false}
                        signaturePlaced={false}
                        showFixedBottomSignaturePlaceholder={showFixedBottomPreview}
                        onClickSignature={() => setSignDialogOpen(true)}
                        signaturePending={signMutation.isPending}
                      />
                    ) : (
                      <div className="flex items-center justify-center min-h-[600px] p-8 bg-muted rounded-md">
                        <FileText className="h-16 w-16 text-muted-foreground/20" />
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
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
          </>
        )}
      </div>

      <Dialog open={startConfirmOpen} onOpenChange={setStartConfirmOpen}>
        <DialogContent data-testid="dialog-start-confirm">
          <DialogHeader>
            <DialogTitle>Ready to sign — are you sure?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              You are about to enter the guided signing workflow. Once you start, you will be walked through
              the document one page at a time. Each page must be initialed in sequence before you can apply
              your final signature.
            </p>
            <p className="text-sm text-muted-foreground">
              You may still go back to a page you have already initialed at any time.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setStartConfirmOpen(false)}
              data-testid="button-cancel-start"
            >
              Cancel
            </Button>
            <Button
              onClick={confirmStart}
              className="bg-[#F97316] border-[#F97316] text-white"
              data-testid="button-confirm-start"
            >
              <PenTool className="h-4 w-4 mr-2" />
              Yes, start signing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
