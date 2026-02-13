import { LayoutDashboard, Plus, Settings, Mail, Shield } from "lucide-react";
import archisignLogo from "@assets/Generated_Image_February_13__2026_-_7_21AM-removebg-preview_1770963731125.png";
import { useLocation, Link } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import type { Envelope } from "@shared/schema";

const navItems = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "New Envelope", url: "/envelopes/new", icon: Plus },
  { title: "Settings", url: "/settings", icon: Settings },
  { title: "Pre-Deployment", url: "/pre-deployment", icon: Shield },
];

export function AppSidebar() {
  const [location] = useLocation();

  const { data: envelopes } = useQuery<Envelope[]>({
    queryKey: ["/api/envelopes"],
  });

  const queriedCount = envelopes?.filter(e => e.status === "queried").length || 0;

  return (
    <Sidebar>
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2">
          <img src={archisignLogo} alt="Archisign" className="h-28 w-auto object-contain" data-testid="img-sidebar-logo" />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={location === item.url}
                  >
                    <Link href={item.url} data-testid={`link-nav-${item.title.toLowerCase().replace(/\s/g, '-')}`}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center justify-between gap-2">
            <span>Status Overview</span>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <div className="space-y-1 px-2">
              <StatusRow label="Draft" count={envelopes?.filter(e => e.status === "draft").length || 0} />
              <StatusRow label="Sent" count={envelopes?.filter(e => e.status === "sent").length || 0} />
              <StatusRow label="Viewed" count={envelopes?.filter(e => e.status === "viewed").length || 0} />
              <StatusRow label="Queried" count={queriedCount} highlight />
              <StatusRow label="Signed" count={envelopes?.filter(e => e.status === "signed").length || 0} />
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Mail className="h-3 w-3" />
          <span>Gmail Connected</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function StatusRow({ label, count, highlight }: { label: string; count: number; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Badge
        variant={highlight && count > 0 ? "destructive" : "secondary"}
        className="text-xs"
        data-testid={`badge-status-${label.toLowerCase()}`}
      >
        {count}
      </Badge>
    </div>
  );
}
