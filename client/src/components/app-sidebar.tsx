import { LayoutDashboard, Plus, Settings, Mail, Shield, History, Database, ChevronRight, LogOut } from "lucide-react";
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
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import type { Envelope } from "@shared/schema";

const settingsSubItems = [
  { title: "Rollback Ledger", url: "/rollback-ledger", icon: History },
  { title: "Data Recovery", url: "/data-recovery", icon: Database },
  { title: "Pre-Deployment", url: "/pre-deployment", icon: Shield },
];

export function AppSidebar() {
  const [location, navigate] = useLocation();

  const { data: envelopes } = useQuery<Envelope[]>({
    queryKey: ["/api/envelopes"],
  });

  const queriedCount = envelopes?.filter(e => e.status === "queried").length || 0;

  const settingsActive = location === "/settings" || settingsSubItems.some(s => location === s.url);

  return (
    <Sidebar>
      <SidebarHeader className="p-4 space-y-4">
        <Link href="/" className="flex items-center gap-2 cursor-pointer" data-testid="link-sidebar-logo">
          <img src={archisignLogo} alt="Archisign" className="h-28 w-auto object-contain" data-testid="img-sidebar-logo" />
        </Link>
        <Button
          onClick={() => navigate("/envelopes/new")}
          className="w-full bg-[#F59E0B] text-white border-2 border-[#D97706] font-semibold uppercase tracking-wide"
          data-testid="button-sidebar-new-envelope"
        >
          New Envelope
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
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
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={location === "/"}
                  className="text-[#7D7E82]"
                >
                  <Link href="/" data-testid="link-nav-dashboard">
                    <LayoutDashboard className="h-4 w-4" />
                    <span>Dashboard</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <Collapsible defaultOpen={settingsActive} className="group/collapsible">
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton
                      isActive={settingsActive}
                      data-testid="link-nav-settings"
                      className="text-[#7D7E82]"
                    >
                      <Settings className="h-4 w-4" />
                      <span>Settings</span>
                      <ChevronRight className="ml-auto h-4 w-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          asChild
                          isActive={location === "/settings"}
                        >
                          <Link href="/settings" data-testid="link-nav-general-settings">
                            <span>General</span>
                          </Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      {settingsSubItems.map((item) => (
                        <SidebarMenuSubItem key={item.title}>
                          <SidebarMenuSubButton
                            asChild
                            isActive={location === item.url}
                          >
                            <Link href={item.url} data-testid={`link-nav-${item.title.toLowerCase().replace(/\s/g, '-')}`}>
                              <item.icon className="h-3 w-3" />
                              <span>{item.title}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 space-y-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Mail className="h-3 w-3" />
          <span>Gmail Connected</span>
        </div>
        <UserInfo />
        <p className="text-[10px] text-muted-foreground text-left uppercase" data-testid="text-version">v1.0.0</p>
      </SidebarFooter>
    </Sidebar>
  );
}

function UserInfo() {
  const { user } = useAuth();
  if (!user) return null;

  const initials = [user.firstName, user.lastName]
    .filter(Boolean)
    .map(n => n![0])
    .join("")
    .toUpperCase() || "U";

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || "User";

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <Avatar className="h-7 w-7 shrink-0">
          <AvatarImage src={user.profileImageUrl || undefined} alt={displayName} />
          <AvatarFallback className="text-xs">{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="text-xs font-medium truncate" data-testid="text-user-name">{displayName}</p>
          {user.email && (
            <p className="text-[10px] text-muted-foreground truncate" data-testid="text-user-email">{user.email}</p>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        asChild
        data-testid="button-logout"
      >
        <a href="/api/logout">
          <LogOut className="h-4 w-4" />
        </a>
      </Button>
    </div>
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
