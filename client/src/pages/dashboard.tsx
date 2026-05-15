import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Filter, ChevronDown } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Search, Plus, FileText, Eye, Clock, AlertTriangle, CheckCircle2, Send, Building2, Users } from "lucide-react";
import type { Envelope, Signer } from "@shared/schema";
import { format } from "date-fns";

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: any }> = {
  draft: { label: "Draft", variant: "secondary", icon: FileText },
  sent: { label: "Sent", variant: "default", icon: Send },
  viewed: { label: "Viewed", variant: "outline", icon: Eye },
  queried: { label: "Queried", variant: "destructive", icon: AlertTriangle },
  signed: { label: "Signed", variant: "default", icon: CheckCircle2 },
  declined: { label: "Declined", variant: "destructive", icon: AlertTriangle },
};

const ALL_STATUSES = ["draft", "sent", "viewed", "queried", "signed", "declined"] as const;
type StatusKey = (typeof ALL_STATUSES)[number];
const DEFAULT_STATUSES: StatusKey[] = ["draft", "sent", "viewed", "queried", "declined"];
const STATUS_FILTER_STORAGE_KEY = "archisign:dashboard:statusFilter";

function loadStoredStatuses(): StatusKey[] {
  if (typeof window === "undefined") return DEFAULT_STATUSES;
  try {
    const raw = window.localStorage.getItem(STATUS_FILTER_STORAGE_KEY);
    if (!raw) return DEFAULT_STATUSES;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_STATUSES;
    const valid = parsed.filter((s): s is StatusKey =>
      (ALL_STATUSES as readonly string[]).includes(s),
    );
    return valid;
  } catch {
    return DEFAULT_STATUSES;
  }
}

export default function Dashboard() {
  const [, navigate] = useLocation();
  const [projectSearch, setProjectSearch] = useState("");
  const [partnerSearch, setPartnerSearch] = useState("");
  const [generalSearch, setGeneralSearch] = useState("");
  const [selectedStatuses, setSelectedStatuses] = useState<StatusKey[]>(loadStoredStatuses);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STATUS_FILTER_STORAGE_KEY, JSON.stringify(selectedStatuses));
    } catch {
      // Quota / private-mode / disabled-storage failures are non-fatal — the
      // filter still works in-memory; persistence simply degrades gracefully.
    }
  }, [selectedStatuses]);

  const selectedSet = new Set<StatusKey>(selectedStatuses);
  const allSelected = selectedStatuses.length === ALL_STATUSES.length;
  const noneSelected = selectedStatuses.length === 0;

  function toggleStatus(status: StatusKey, checked: boolean) {
    setSelectedStatuses((prev) => {
      const set = new Set(prev);
      if (checked) set.add(status);
      else set.delete(status);
      return ALL_STATUSES.filter((s) => set.has(s));
    });
  }

  const { data: envelopes, isLoading } = useQuery<(Envelope & { signers: Signer[] })[]>({
    queryKey: ["/api/envelopes"],
    refetchInterval: 10000,
  });

  const filtered = envelopes?.filter((env) => {
    const matchesProject =
      !projectSearch ||
      env.subject.toLowerCase().includes(projectSearch.toLowerCase()) ||
      env.externalRef?.toLowerCase().includes(projectSearch.toLowerCase());

    const matchesPartner =
      !partnerSearch ||
      env.signers?.some(s =>
        s.fullName.toLowerCase().includes(partnerSearch.toLowerCase()) ||
        s.email.toLowerCase().includes(partnerSearch.toLowerCase())
      );

    const matchesGeneral =
      !generalSearch ||
      env.subject.toLowerCase().includes(generalSearch.toLowerCase()) ||
      env.externalRef?.toLowerCase().includes(generalSearch.toLowerCase()) ||
      env.message?.toLowerCase().includes(generalSearch.toLowerCase()) ||
      env.signers?.some(s =>
        s.fullName.toLowerCase().includes(generalSearch.toLowerCase()) ||
        s.email.toLowerCase().includes(generalSearch.toLowerCase())
      );

    const matchesStatus = selectedSet.has(env.status as StatusKey);
    return matchesProject && matchesPartner && matchesGeneral && matchesStatus;
  });

  const stats = {
    total: envelopes?.length || 0,
    pending: envelopes?.filter(e => e.status === "sent" || e.status === "viewed").length || 0,
    queried: envelopes?.filter(e => e.status === "queried").length || 0,
    signed: envelopes?.filter(e => e.status === "signed").length || 0,
  };

  function applyStatusPreset(preset: StatusKey[]) {
    setSelectedStatuses(ALL_STATUSES.filter((s) => preset.includes(s)));
    setProjectSearch("");
    setPartnerSearch("");
    setGeneralSearch("");
  }

  function arraysEqualAsSets(a: StatusKey[], b: StatusKey[]) {
    if (a.length !== b.length) return false;
    const sa = new Set(a);
    return b.every((x) => sa.has(x));
  }

  const statusFilterLabel = noneSelected
    ? "No statuses"
    : allSelected
      ? "All statuses"
      : selectedStatuses.length === 1
        ? statusConfig[selectedStatuses[0]]?.label ?? selectedStatuses[0]
        : `${selectedStatuses.length} statuses`;

  return (
    <div className="flex flex-col h-full">
      <div className="p-6 space-y-6 overflow-auto flex-1">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold" data-testid="text-dashboard-title">Sign-Off Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">Manage architectural plan sign-offs and approvals</p>
          </div>
          <Button onClick={() => navigate("/envelopes/new")} data-testid="button-new-envelope">
            <Plus className="h-4 w-4 mr-2" />
            New Envelope
          </Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Total Envelopes"
            value={stats.total}
            icon={FileText}
            borderColor="border-primary"
            onClick={() => applyStatusPreset([...ALL_STATUSES])}
            active={allSelected}
          />
          <StatCard
            label="Awaiting Signature"
            value={stats.pending}
            icon={Clock}
            borderColor="border-destructive"
            onClick={() => applyStatusPreset(["sent", "viewed"])}
            active={arraysEqualAsSets(selectedStatuses, ["sent", "viewed"])}
          />
          <StatCard
            label="Queries Raised"
            value={stats.queried}
            icon={AlertTriangle}
            highlight
            borderColor="border-chart-4"
            onClick={() => applyStatusPreset(["queried"])}
            active={arraysEqualAsSets(selectedStatuses, ["queried"])}
          />
          <StatCard
            label="Completed"
            value={stats.signed}
            icon={CheckCircle2}
            borderColor="border-chart-3"
            onClick={() => applyStatusPreset(["signed"])}
            active={arraysEqualAsSets(selectedStatuses, ["signed"])}
          />
        </div>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[160px]">
                <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by project..."
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                  className="pl-9"
                  data-testid="input-search-project"
                />
              </div>
              <div className="relative flex-1 min-w-[160px]">
                <Users className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by partner..."
                  value={partnerSearch}
                  onChange={(e) => setPartnerSearch(e.target.value)}
                  className="pl-9"
                  data-testid="input-search-partner"
                />
              </div>
              <div className="relative flex-1 min-w-[160px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="General search..."
                  value={generalSearch}
                  onChange={(e) => setGeneralSearch(e.target.value)}
                  className="pl-9"
                  data-testid="input-search-general"
                />
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-[200px] justify-between font-normal"
                    data-testid="button-status-filter"
                  >
                    <span className="flex items-center gap-2 truncate">
                      <Filter className="h-4 w-4 text-muted-foreground" />
                      <span className="truncate">{statusFilterLabel}</span>
                    </span>
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-64 p-0">
                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="text-sm font-medium">Show statuses</span>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => setSelectedStatuses([...ALL_STATUSES])}
                        data-testid="button-status-filter-all"
                      >
                        All
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => setSelectedStatuses([])}
                        data-testid="button-status-filter-none"
                      >
                        None
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => setSelectedStatuses([...DEFAULT_STATUSES])}
                        data-testid="button-status-filter-default"
                      >
                        Default
                      </Button>
                    </div>
                  </div>
                  <Separator />
                  <div className="p-2 space-y-1">
                    {ALL_STATUSES.map((status) => {
                      const cfg = statusConfig[status];
                      const Icon = cfg.icon;
                      const checked = selectedSet.has(status);
                      return (
                        <label
                          key={status}
                          className="flex items-center gap-3 rounded-md px-2 py-1.5 cursor-pointer hover-elevate"
                          data-testid={`row-status-filter-${status}`}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) => toggleStatus(status, v === true)}
                            data-testid={`checkbox-status-${status}`}
                          />
                          <Icon className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm flex-1">{cfg.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-6 space-y-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : !filtered || filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <FileText className="h-12 w-12 text-muted-foreground/40 mb-4" />
                <h3 className="font-medium text-muted-foreground">No envelopes found</h3>
                <p className="text-sm text-muted-foreground/60 mt-1">Create a new envelope to get started</p>
                <Button onClick={() => navigate("/envelopes/new")} variant="outline" className="mt-4" data-testid="button-empty-new">
                  <Plus className="h-4 w-4 mr-2" />
                  New Envelope
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Signer(s)</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((env) => {
                    const config = statusConfig[env.status] || statusConfig.draft;
                    const StatusIcon = config.icon;
                    return (
                      <TableRow
                        key={env.id}
                        className="cursor-pointer hover-elevate"
                        onClick={() => navigate(`/envelopes/${env.id}`)}
                        data-testid={`row-envelope-${env.id}`}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <span className="font-medium">{env.subject}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-muted-foreground text-sm">{env.externalRef || "—"}</span>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            {env.signers?.slice(0, 2).map((s) => (
                              <span key={s.id} className="text-sm">{s.fullName}</span>
                            ))}
                            {(env.signers?.length || 0) > 2 && (
                              <span className="text-xs text-muted-foreground">+{env.signers!.length - 2} more</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={config.variant} data-testid={`badge-envelope-status-${env.id}`}>
                            <StatusIcon className="h-3 w-3 mr-1" />
                            {config.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground">
                            {format(new Date(env.createdAt), "MMM d, yyyy")}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="ghost" data-testid={`button-view-envelope-${env.id}`}>
                            <Eye className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon: Icon, highlight, borderColor, onClick, active }: {
  label: string;
  value: number;
  icon: any;
  highlight?: boolean;
  borderColor?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const clickable = !!onClick;
  return (
    <Card
      className={`border-[3px] ${borderColor || "border-border"} ${clickable ? "cursor-pointer hover-elevate" : ""} ${active ? "ring-2 ring-ring ring-offset-2" : ""}`}
      onClick={onClick}
      data-testid={`card-stat-${label.toLowerCase().replace(/\s/g, '-')}`}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={`text-2xl font-semibold mt-1 ${highlight && value > 0 ? "text-destructive" : ""}`}>
              {value}
            </p>
          </div>
          <div className={`flex h-9 w-9 items-center justify-center rounded-md ${highlight && value > 0 ? "bg-destructive/10" : "bg-muted"}`}>
            <Icon className={`h-4 w-4 ${highlight && value > 0 ? "text-destructive" : "text-muted-foreground"}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
