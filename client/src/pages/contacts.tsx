import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Plus, Pencil, Archive, Loader2, Lock } from "lucide-react";
import type { Contact } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { localContactCreateSchema } from "@shared/schema";
import type { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

type ContactFormValues = z.infer<typeof localContactCreateSchema>;

type FilterValue = "all" | "archidoc" | "local" | "archived";

export default function ContactsPage() {
  const { toast } = useToast();
  const [filter, setFilter] = useState<FilterValue>("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Contact | null>(null);
  const [creating, setCreating] = useState(false);

  const params: Record<string, string> = {};
  if (search) params.q = search;
  if (filter === "archidoc" || filter === "local") params.source = filter;
  if (filter === "archived") params.includeArchived = "1";
  const qs = new URLSearchParams(params).toString();

  const { data: contacts = [], isLoading } = useQuery<Contact[]>({
    queryKey: ["/api/contacts", params],
    queryFn: async () => {
      const res = await fetch(`/api/contacts${qs ? `?${qs}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load contacts");
      return res.json();
    },
  });

  const visible = filter === "archived"
    ? contacts.filter((c) => !!c.archivedAt)
    : contacts;

  const archiveMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/contacts/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: "Contact archived" });
    },
    onError: (err: Error) => toast({ title: "Failed to archive", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="p-6 space-y-4 max-w-5xl mx-auto w-full">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold" data-testid="text-contacts-title">Contacts</h1>
            <p className="text-sm text-muted-foreground mt-1">Address book powering the New Envelope picker.</p>
          </div>
          <Button onClick={() => setCreating(true)} data-testid="button-new-contact">
            <Plus className="h-4 w-4 mr-1" /> New Contact
          </Button>
        </div>

        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[240px]">
                <Label htmlFor="contacts-search" className="text-xs">Search</Label>
                <Input
                  id="contacts-search"
                  placeholder="Name, email, or organization…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  data-testid="input-contacts-search"
                />
              </div>
              <div className="w-44">
                <Label className="text-xs">Source</Label>
                <Select value={filter} onValueChange={(v) => setFilter(v as FilterValue)}>
                  <SelectTrigger data-testid="select-contacts-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="archidoc">ArchiDoc</SelectItem>
                    <SelectItem value="local">Local</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Organization</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-10">
                        No contacts.
                      </TableCell>
                    </TableRow>
                  )}
                  {visible.map((c) => (
                    <TableRow key={c.id} data-testid={`row-contact-${c.id}`}>
                      <TableCell className="font-medium">{c.displayName}</TableCell>
                      <TableCell className="text-muted-foreground">{c.email ?? <span className="italic">no email</span>}</TableCell>
                      <TableCell>{c.category}</TableCell>
                      <TableCell>{c.organization || "—"}</TableCell>
                      <TableCell>
                        {c.source === "archidoc" ? (
                          <Tooltip>
                            <TooltipTrigger>
                              <Badge variant="default" className="gap-1"><Lock className="h-3 w-3" /> ArchiDoc</Badge>
                            </TooltipTrigger>
                            <TooltipContent>Synced from ArchiDoc — read-only</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Badge variant="secondary">Local</Badge>
                        )}
                        {c.archivedAt && <Badge variant="outline" className="ml-1">archived</Badge>}
                      </TableCell>
                      <TableCell className="text-right">
                        {c.source === "local" ? (
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="icon" onClick={() => setEditing(c)} data-testid={`button-edit-contact-${c.id}`}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            {!c.archivedAt && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => archiveMutation.mutate(c.id)}
                                data-testid={`button-archive-contact-${c.id}`}
                              >
                                <Archive className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger>
                              <Button variant="ghost" size="icon" disabled data-testid={`button-edit-contact-${c.id}-disabled`}>
                                <Pencil className="h-4 w-4 opacity-30" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Synced from ArchiDoc — read-only</TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <ContactDialog
        open={creating}
        onClose={() => setCreating(false)}
        contact={null}
      />
      <ContactDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        contact={editing}
      />
    </div>
  );
}

function ContactDialog({ open, onClose, contact }: { open: boolean; onClose: () => void; contact: Contact | null }) {
  const { toast } = useToast();
  const form = useForm<ContactFormValues>({
    resolver: zodResolver(localContactCreateSchema),
    values: contact ? {
      // Local-contact admin form requires email; archidoc rows are read-only here.
      email: contact.email ?? "",
      displayName: contact.displayName,
      organization: contact.organization ?? "",
      category: (contact.category as ContactFormValues["category"]) ?? "other",
      role: contact.role ?? "",
      phone: contact.phone ?? "",
    } : {
      email: "", displayName: "", organization: "", category: "other", role: "", phone: "",
    },
  });

  const mutation = useMutation({
    mutationFn: async (values: ContactFormValues) => {
      if (contact) {
        const res = await apiRequest("PATCH", `/api/contacts/${contact.id}`, values);
        return res.json();
      }
      const res = await apiRequest("POST", "/api/contacts", values);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: contact ? "Contact updated" : "Contact created" });
      onClose();
      form.reset();
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{contact ? "Edit contact" : "New contact"}</DialogTitle>
          <DialogDescription>Local contacts only. ArchiDoc-synced contacts are managed upstream.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="space-y-3">
            <FormField control={form.control} name="displayName" render={({ field }) => (
              <FormItem>
                <FormLabel>Display name</FormLabel>
                <FormControl><Input {...field} data-testid="input-contact-name" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="email" render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl><Input type="email" {...field} data-testid="input-contact-email" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="organization" render={({ field }) => (
              <FormItem>
                <FormLabel>Organization</FormLabel>
                <FormControl><Input {...field} value={field.value ?? ""} data-testid="input-contact-organization" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="category" render={({ field }) => (
              <FormItem>
                <FormLabel>Category</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl><SelectTrigger data-testid="select-contact-category"><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="client">Client</SelectItem>
                    <SelectItem value="contractor">Contractor</SelectItem>
                    <SelectItem value="partner">Partner</SelectItem>
                    <SelectItem value="internal">Internal</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="role" render={({ field }) => (
              <FormItem>
                <FormLabel>Role</FormLabel>
                <FormControl><Input {...field} value={field.value ?? ""} data-testid="input-contact-role" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="phone" render={({ field }) => (
              <FormItem>
                <FormLabel>Phone</FormLabel>
                <FormControl><Input {...field} value={field.value ?? ""} data-testid="input-contact-phone" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={mutation.isPending} data-testid="button-save-contact">
                {mutation.isPending ? "Saving…" : contact ? "Save" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
