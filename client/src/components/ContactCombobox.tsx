import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Check, ChevronsUpDown, UserPlus, Loader2, Users as UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Contact } from "@shared/schema";

export interface ContactPick {
  contactId: number | null;
  fullName: string;
  email: string;
}

function emailOf(c: Contact): string {
  return c.email ?? "";
}

/**
 * v1.3.2: build a lowercase-email → count map across ALL active contacts
 * (regardless of source). A local row + an archidoc row sharing the same
 * inbox both count toward the warning — same human, two table rows.
 */
export function buildSharedEmailMap(contacts: Contact[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  if (!contacts) return m;
  for (const c of contacts) {
    if (c.archivedAt || !c.email) continue;
    const k = c.email.toLowerCase();
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export function isSharedInbox(map: Map<string, number>, email: string | null | undefined): boolean {
  if (!email) return false;
  return (map.get(email.toLowerCase()) ?? 0) > 1;
}

interface Props {
  value: ContactPick | null;
  onChange: (pick: ContactPick) => void;
  placeholder?: string;
  testIdPrefix?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function useDebounce<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function ContactCombobox({ value, onChange, placeholder, testIdPrefix = "contact" }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounce(query, 200);

  const { data: contacts = [], isFetching } = useQuery<Contact[]>({
    queryKey: ["/api/contacts", { q: debounced }],
    queryFn: async () => {
      const url = debounced ? `/api/contacts?q=${encodeURIComponent(debounced)}` : "/api/contacts";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load contacts");
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (input: { email: string; displayName: string }) => {
      const res = await apiRequest("POST", "/api/contacts", { ...input, category: "other" });
      return res.json() as Promise<Contact>;
    },
    onSuccess: (contact) => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      onChange({ contactId: contact.id, fullName: contact.displayName, email: emailOf(contact) });
      setOpen(false);
      setQuery("");
      toast({ title: "Contact added", description: `${contact.displayName} (${emailOf(contact)})` });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add contact", description: err.message, variant: "destructive" });
    },
  });

  const sharedEmailMap = useMemo(() => buildSharedEmailMap(contacts), [contacts]);

  const grouped = useMemo(() => {
    // v1.3.1: ArchiDoc may sync email-less contacts (system actors / contractors).
    // Envelope signers REQUIRE an email (OTP + sign-link delivery), so we hide
    // email-less rows from the picker rather than crash on .email.toLowerCase().
    const visible = contacts.filter((c) => !c.archivedAt && !!c.email);
    const recent = [...visible]
      .filter((c) => c.lastUsedAt)
      .sort((a, b) => new Date(b.lastUsedAt!).getTime() - new Date(a.lastUsedAt!).getTime())
      .slice(0, 5);
    const recentIds = new Set(recent.map((c) => c.id));
    const archidoc = visible.filter((c) => c.source === "archidoc" && !recentIds.has(c.id));
    const local = visible.filter((c) => c.source === "local" && !recentIds.has(c.id));
    return { recent, archidoc, local };
  }, [contacts]);

  const trimmedQuery = query.trim();
  const isEmail = EMAIL_RE.test(trimmedQuery);
  const exactMatch = contacts.find((c) => (c.email ?? "").toLowerCase() === trimmedQuery.toLowerCase() && !!c.email);
  const showAddNew = isEmail && !exactMatch && !createMutation.isPending;

  function pickContact(c: Contact) {
    onChange({ contactId: c.id, fullName: c.displayName, email: emailOf(c) });
    setOpen(false);
    setQuery("");
  }

  function handleAddNew() {
    createMutation.mutate({ email: trimmedQuery.toLowerCase(), displayName: trimmedQuery.split("@")[0] });
  }

  const triggerLabel = value && value.email
    ? `${value.fullName} <${value.email}>`
    : (placeholder || "Select contact…");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          data-testid={`${testIdPrefix}-trigger`}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search by name or email…"
            value={query}
            onValueChange={setQuery}
            data-testid={`${testIdPrefix}-search`}
          />
          <CommandList>
            {isFetching && (
              <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin mr-2" /> Loading…
              </div>
            )}
            {!isFetching && contacts.length === 0 && !showAddNew && (
              <CommandEmpty>No contacts found.</CommandEmpty>
            )}
            {grouped.recent.length > 0 && (
              <CommandGroup heading="Recent">
                {grouped.recent.map((c) => (
                  <ContactRow key={c.id} contact={c} onSelect={pickContact} selected={value?.contactId === c.id} testIdPrefix={testIdPrefix} sharedEmailMap={sharedEmailMap} />
                ))}
              </CommandGroup>
            )}
            {grouped.archidoc.length > 0 && (
              <>
                {grouped.recent.length > 0 && <CommandSeparator />}
                <CommandGroup heading="ArchiDoc">
                  {grouped.archidoc.map((c) => (
                    <ContactRow key={c.id} contact={c} onSelect={pickContact} selected={value?.contactId === c.id} testIdPrefix={testIdPrefix} sharedEmailMap={sharedEmailMap} />
                  ))}
                </CommandGroup>
              </>
            )}
            {grouped.local.length > 0 && (
              <>
                {(grouped.recent.length > 0 || grouped.archidoc.length > 0) && <CommandSeparator />}
                <CommandGroup heading="Local">
                  {grouped.local.map((c) => (
                    <ContactRow key={c.id} contact={c} onSelect={pickContact} selected={value?.contactId === c.id} testIdPrefix={testIdPrefix} sharedEmailMap={sharedEmailMap} />
                  ))}
                </CommandGroup>
              </>
            )}
            {showAddNew && (
              <>
                <CommandSeparator />
                <CommandGroup heading="New">
                  <CommandItem
                    value={`__add__${trimmedQuery}`}
                    onSelect={handleAddNew}
                    data-testid={`${testIdPrefix}-add-new`}
                  >
                    <UserPlus className="mr-2 h-4 w-4" />
                    <span>Add <strong className="font-medium">{trimmedQuery}</strong> as new contact</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ContactRow({
  contact, onSelect, selected, testIdPrefix, sharedEmailMap,
}: {
  contact: Contact; onSelect: (c: Contact) => void; selected: boolean; testIdPrefix: string;
  sharedEmailMap: Map<string, number>;
}) {
  const sharedCount = contact.email ? (sharedEmailMap.get(contact.email.toLowerCase()) ?? 0) : 0;
  const isShared = sharedCount > 1;
  return (
    <CommandItem
      value={`${contact.id}-${contact.email ?? "noemail"}-${contact.displayName}`}
      onSelect={() => onSelect(contact)}
      data-testid={`${testIdPrefix}-item-${contact.id}`}
    >
      <Check className={cn("mr-2 h-4 w-4", selected ? "opacity-100" : "opacity-0")} />
      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate">{contact.displayName}</span>
          <Badge variant={contact.source === "archidoc" ? "default" : "secondary"} className="text-[10px] px-1.5 py-0">
            {contact.source === "archidoc" ? "ArchiDoc" : "Local"}
          </Badge>
          {isShared && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 border-amber-500/60 text-amber-700 dark:text-amber-400"
              data-testid={`${testIdPrefix}-shared-${contact.id}`}
              title={`${sharedCount} active contacts share this inbox — verify the name before sending`}
            >
              <UsersIcon className="h-2.5 w-2.5 mr-0.5" />
              shared inbox · {sharedCount}
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {contact.email ?? <span className="italic">no email</span>}
          {contact.organization && <span> · {contact.organization}</span>}
          {contact.category && contact.category !== "other" && <span> · {contact.category}</span>}
        </div>
      </div>
    </CommandItem>
  );
}
