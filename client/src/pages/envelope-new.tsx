import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Setting } from "@shared/schema";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowLeft, Plus, Trash2, Upload, FileText } from "lucide-react";
import { ContactCombobox, type ContactPick, buildSharedEmailMap, isSharedInbox } from "@/components/ContactCombobox";
import { Users as UsersIcon } from "lucide-react";
import type { Contact } from "@shared/schema";
import { Badge } from "@/components/ui/badge";

const formSchema = z.object({
  subject: z.string().min(1, "Subject is required"),
  externalRef: z.string().optional(),
  webhookUrl: z.string().url("Must be a valid URL").optional().or(z.literal("")),
  message: z.string().optional(),
  signerName: z.string().min(1, "Signer name is required"),
  signerEmail: z.string().email("Valid email required"),
  signaturePlacementMode: z.enum(["fixed_bottom_centre", "admin_placed"]),
});

type FormValues = z.infer<typeof formSchema>;

export default function EnvelopeNew() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [primarySigner, setPrimarySigner] = useState<ContactPick | null>(null);
  const [additionalSigners, setAdditionalSigners] = useState<Array<ContactPick>>([]);
  const [pdfFile, setPdfFile] = useState<File | null>(null);

  const { data: settings } = useQuery<Setting[]>({ queryKey: ["/api/settings"] });
  // v1.3.2: re-uses ContactCombobox's React-Query cache (same key) so this is free.
  const { data: contacts } = useQuery<Contact[]>({ queryKey: ["/api/contacts", { q: "" }] });
  const sharedEmailMap = useMemo(() => buildSharedEmailMap(contacts), [contacts]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      subject: "",
      externalRef: "",
      webhookUrl: "",
      message: "",
      signerName: "",
      signerEmail: "",
      signaturePlacementMode: "fixed_bottom_centre",
    },
  });

  useEffect(() => {
    if (!settings) return;
    const def = settings.find((s) => s.key === "default_signature_placement_mode")?.value;
    if (def === "admin_placed" || def === "fixed_bottom_centre") {
      if (!form.formState.dirtyFields.signaturePlacementMode) {
        form.setValue("signaturePlacementMode", def);
      }
    }
  }, [settings, form]);

  const createMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const formData = new FormData();
      formData.append("subject", values.subject);
      if (values.externalRef) formData.append("externalRef", values.externalRef);
      if (values.webhookUrl) formData.append("webhookUrl", values.webhookUrl);
      if (values.message) formData.append("message", values.message);

      const allSigners = [
        { fullName: values.signerName, email: values.signerEmail },
        ...additionalSigners.filter(s => s.fullName && s.email).map(s => ({ fullName: s.fullName, email: s.email })),
      ];
      formData.append("signers", JSON.stringify(allSigners));
      formData.append("signaturePlacementMode", values.signaturePlacementMode);

      if (pdfFile) {
        formData.append("pdf", pdfFile);
      }

      const res = await fetch("/api/envelopes", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to create envelope");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/envelopes"] });
      toast({ title: "Envelope created", description: "Your envelope has been created successfully." });
      navigate(`/envelopes/${data.id}`);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const addSigner = () => {
    setAdditionalSigners(prev => [...prev, { contactId: null, fullName: "", email: "" }]);
  };

  const removeSigner = (index: number) => {
    setAdditionalSigners(prev => prev.filter((_, i) => i !== index));
  };

  const updateSigner = (index: number, pick: ContactPick) => {
    setAdditionalSigners(prev => {
      const updated = [...prev];
      updated[index] = pick;
      return updated;
    });
  };

  function handlePrimaryPick(pick: ContactPick) {
    setPrimarySigner(pick);
    form.setValue("signerName", pick.fullName, { shouldValidate: true });
    form.setValue("signerEmail", pick.email, { shouldValidate: true });
  }

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="p-6 space-y-6 max-w-2xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")} data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-semibold" data-testid="text-new-envelope-title">New Envelope</h1>
            <p className="text-sm text-muted-foreground mt-1">Create a new document for external sign-off</p>
          </div>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => createMutation.mutate(v))} className="space-y-6">
            <Card>
              <CardContent className="p-6 space-y-4">
                <h3 className="font-medium">Document Details</h3>
                <FormField
                  control={form.control}
                  name="subject"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Subject</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g., Villa Renovation Plans - Phase 2" {...field} data-testid="input-subject" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="externalRef"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>ArchiDoc Reference (optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g., PROJ-2024-042" {...field} data-testid="input-external-ref" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="webhookUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Webhook Callback URL (optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="https://archidoc.example.com/webhook" {...field} data-testid="input-webhook-url" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="message"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Message to signers (optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Add a personal message to include in the signing invitation email..."
                          className="resize-none"
                          rows={3}
                          {...field}
                          data-testid="input-message"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="signaturePlacementMode"
                  render={({ field }) => (
                    <FormItem className="space-y-2">
                      <FormLabel>Signature Placement</FormLabel>
                      <FormControl>
                        <RadioGroup
                          value={field.value}
                          onValueChange={field.onChange}
                          className="grid gap-2"
                        >
                          <label
                            htmlFor="placement-fixed"
                            className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover-elevate"
                            data-testid="radio-placement-fixed_bottom_centre"
                          >
                            <RadioGroupItem id="placement-fixed" value="fixed_bottom_centre" className="mt-0.5" />
                            <div className="space-y-0.5">
                              <p className="text-sm font-medium">Fixed (bottom centre)</p>
                              <p className="text-xs text-muted-foreground">
                                Signatures are stamped automatically at the bottom centre of the last page.
                              </p>
                            </div>
                          </label>
                          <label
                            htmlFor="placement-admin"
                            className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover-elevate"
                            data-testid="radio-placement-admin_placed"
                          >
                            <RadioGroupItem id="placement-admin" value="admin_placed" className="mt-0.5" />
                            <div className="space-y-0.5">
                              <p className="text-sm font-medium">Admin placed (free placement)</p>
                              <p className="text-xs text-muted-foreground">
                                Open the field editor after creation to drop signature, initial, and date fields anywhere on the document.
                              </p>
                            </div>
                          </label>
                        </RadioGroup>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div>
                  <Label>PDF Document</Label>
                  <div className="mt-2">
                    {pdfFile ? (
                      <div className="flex items-center gap-3 p-3 rounded-md bg-muted">
                        <FileText className="h-5 w-5 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{pdfFile.name}</p>
                          <p className="text-xs text-muted-foreground">{(pdfFile.size / 1024 / 1024).toFixed(2)} MB</p>
                        </div>
                        <Button type="button" variant="ghost" size="icon" onClick={() => setPdfFile(null)} data-testid="button-remove-pdf">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <label className="flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-md cursor-pointer hover-elevate transition-colors" data-testid="input-pdf-upload">
                        <Upload className="h-8 w-8 text-muted-foreground/40 mb-2" />
                        <span className="text-sm text-muted-foreground">Click to upload PDF</span>
                        <span className="text-xs text-muted-foreground/60 mt-1">Supports architectural plans (A4, A3, A2)</span>
                        <input
                          type="file"
                          accept=".pdf"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) setPdfFile(file);
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium">Signers</h3>
                  <Button type="button" variant="outline" size="sm" onClick={addSigner} data-testid="button-add-signer">
                    <Plus className="h-3 w-3 mr-1" />
                    Add Signer
                  </Button>
                </div>

                <div>
                  <Label className="text-xs">Primary signer</Label>
                  <div className="mt-1">
                    <ContactCombobox
                      value={primarySigner}
                      onChange={handlePrimaryPick}
                      placeholder="Search contacts or add new…"
                      testIdPrefix="primary-signer"
                    />
                  </div>
                  {form.formState.errors.signerEmail && (
                    <p className="text-xs text-destructive mt-1">{form.formState.errors.signerEmail.message}</p>
                  )}
                  {isSharedInbox(sharedEmailMap, primarySigner?.email) && (
                    <SharedInboxNotice email={primarySigner!.email} testId="primary-signer-shared-notice" />
                  )}
                  <input type="hidden" {...form.register("signerName")} />
                  <input type="hidden" {...form.register("signerEmail")} />
                </div>

                {additionalSigners.map((signer, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto] gap-3 items-end">
                    <div>
                      <Label className="text-xs">Additional signer #{i + 2}</Label>
                      <div className="mt-1">
                        <ContactCombobox
                          value={signer}
                          onChange={(p) => updateSigner(i, p)}
                          placeholder="Search contacts or add new…"
                          testIdPrefix={`additional-signer-${i}`}
                        />
                      </div>
                      {isSharedInbox(sharedEmailMap, signer.email) && (
                        <SharedInboxNotice email={signer.email} testId={`additional-signer-${i}-shared-notice`} />
                      )}
                    </div>
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeSigner(i)} data-testid={`button-remove-signer-${i}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>

            <div className="flex items-center justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => navigate("/")} data-testid="button-cancel">
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending} data-testid="button-create-envelope">
                {createMutation.isPending ? "Creating..." : "Create Envelope"}
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}

function SharedInboxNotice({ email, testId }: { email: string; testId: string }) {
  return (
    <div className="mt-2" data-testid={testId}>
      <Badge
        variant="outline"
        className="text-[10px] px-1.5 py-0.5 border-amber-500/60 text-amber-700 dark:text-amber-400"
      >
        <UsersIcon className="h-3 w-3 mr-1" />
        shared inbox — verify the name before sending
      </Badge>
      <p className="text-[11px] text-muted-foreground mt-1">
        Multiple contacts use <code className="font-mono">{email}</code>. The OTP and signing link will be sent to this inbox; double-check the signer name above is correct.
      </p>
    </div>
  );
}
