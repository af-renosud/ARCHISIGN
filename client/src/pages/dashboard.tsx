import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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

export default function Dashboard() {
  const [, navigate] = useLocation();
  const [projectSearch, setProjectSearch] = useState("");
  const [partnerSearch, setPartnerSearch] = useState("");
  const [generalSearch, setGeneralSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: envelopes, isLoading } = useQuery<(Envelope & { signers: Signer[] })[]>({
    queryKey: ["/api/envelopes"],
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

    let matchesStatus = false;
    if (statusFilter === "all") {
      matchesStatus = true;
    } else if (statusFilter === "awaiting") {
      matchesStatus = env.status === "sent" || env.status === "viewed";
    } else {
      matchesStatus = env.status === statusFilter;
    }
    return matchesProject && matchesPartner && matchesGeneral && matchesStatus;
  });

  const stats = {
    total: envelopes?.length || 0,
    pending: envelopes?.filter(e => e.status === "sent" || e.status === "viewed").length || 0,
    queried: envelopes?.filter(e => e.status === "queried").length || 0,
    signed: envelopes?.filter(e => e.status === "signed").length || 0,
  };

  function handleStatCardClick(filterValue: string) {
    setStatusFilter(prev => prev === filterValue ? "all" : filterValue);
    setProjectSearch("");
    setPartnerSearch("");
    setGeneralSearch("");
  }

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
            onClick={() => handleStatCardClick("all")}
            active={statusFilter === "all"}
          />
          <StatCard
            label="Awaiting Signature"
            value={stats.pending}
            icon={Clock}
            borderColor="border-destructive"
            onClick={() => handleStatCardClick("awaiting")}
            active={statusFilter === "awaiting"}
          />
          <StatCard
            label="Queries Raised"
            value={stats.queried}
            icon={AlertTriangle}
            highlight
            borderColor="border-chart-4"
            onClick={() => handleStatCardClick("queried")}
            active={statusFilter === "queried"}
          />
          <StatCard label="Completed" value={stats.signed} icon={CheckCircle2} borderColor="border-chart-3" />
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
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[160px]" data-testid="select-status-filter">
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="viewed">Viewed</SelectItem>
                  <SelectItem value="queried">Queried</SelectItem>
                  <SelectItem value="signed">Signed</SelectItem>
                  <SelectItem value="awaiting">Awaiting Signature</SelectItem>
                </SelectContent>
              </Select>
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
