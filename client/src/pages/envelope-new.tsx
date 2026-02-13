import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
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

const formSchema = z.object({
  subject: z.string().min(1, "Subject is required"),
  externalRef: z.string().optional(),
  webhookUrl: z.string().url("Must be a valid URL").optional().or(z.literal("")),
  signerName: z.string().min(1, "Signer name is required"),
  signerEmail: z.string().email("Valid email required"),
});

type FormValues = z.infer<typeof formSchema>;

export default function EnvelopeNew() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [additionalSigners, setAdditionalSigners] = useState<Array<{ name: string; email: string }>>([]);
  const [pdfFile, setPdfFile] = useState<File | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      subject: "",
      externalRef: "",
      webhookUrl: "",
      signerName: "",
      signerEmail: "",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const formData = new FormData();
      formData.append("subject", values.subject);
      if (values.externalRef) formData.append("externalRef", values.externalRef);
      if (values.webhookUrl) formData.append("webhookUrl", values.webhookUrl);

      const allSigners = [
        { fullName: values.signerName, email: values.signerEmail },
        ...additionalSigners.filter(s => s.name && s.email),
      ];
      formData.append("signers", JSON.stringify(allSigners));

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
    setAdditionalSigners(prev => [...prev, { name: "", email: "" }]);
  };

  const removeSigner = (index: number) => {
    setAdditionalSigners(prev => prev.filter((_, i) => i !== index));
  };

  const updateSigner = (index: number, field: "name" | "email", value: string) => {
    setAdditionalSigners(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

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

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="signerName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Full Name</FormLabel>
                        <FormControl>
                          <Input placeholder="Jean Dupont" {...field} data-testid="input-signer-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="signerEmail"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input placeholder="jean@example.com" {...field} data-testid="input-signer-email" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {additionalSigners.map((signer, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
                    <div>
                      <Label className="text-xs">Full Name</Label>
                      <Input
                        value={signer.name}
                        onChange={(e) => updateSigner(i, "name", e.target.value)}
                        placeholder="Full name"
                        data-testid={`input-additional-signer-name-${i}`}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Email</Label>
                      <Input
                        value={signer.email}
                        onChange={(e) => updateSigner(i, "email", e.target.value)}
                        placeholder="Email"
                        data-testid={`input-additional-signer-email-${i}`}
                      />
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
