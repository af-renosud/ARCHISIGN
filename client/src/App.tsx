import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { useAuth } from "@/hooks/use-auth";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import EnvelopeNew from "@/pages/envelope-new";
import EnvelopeDetail from "@/pages/envelope-detail";
import SignerVerify from "@/pages/signer-verify";
import SignerDocument from "@/pages/signer-document";
import SettingsPage from "@/pages/settings";
import PreDeployment from "@/pages/pre-deployment";
import RollbackLedger from "@/pages/rollback-ledger";
import DataRecovery from "@/pages/data-recovery";
import LoginPage from "@/pages/login";
import { Loader2 } from "lucide-react";

function AdminLayout({ children }: { children: React.ReactNode }) {
  const style = {
    "--sidebar-width": "17rem",
    "--sidebar-width-icon": "3.5rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center justify-between gap-2 p-2 border-b sticky top-0 z-40 bg-background/95 backdrop-blur-sm">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            <ThemeToggle />
          </header>
          <main className="flex-1 overflow-hidden">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function AdminRouter() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/envelopes/new" component={EnvelopeNew} />
      <Route path="/envelopes/:id" component={EnvelopeDetail} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/pre-deployment" component={PreDeployment} />
      <Route path="/rollback-ledger" component={RollbackLedger} />
      <Route path="/data-recovery" component={DataRecovery} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthenticatedAdmin() {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <AdminLayout>
      <AdminRouter />
    </AdminLayout>
  );
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Switch>
            <Route path="/sign/:token" component={SignerVerify} />
            <Route path="/sign/:token/document" component={SignerDocument} />
            <Route>
              <AuthenticatedAdmin />
            </Route>
          </Switch>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
