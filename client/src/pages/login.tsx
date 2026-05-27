import { useEffect, useState } from "react";
import { Shield, FileSignature, Lock, Eye, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import archisignLogo from "@assets/Generated_Image_February_13__2026_-_7_21AM-removebg-preview_1770963731125.png";

type DenialNotice = {
  code: string;
  message: string;
  allowedDomain: string | null;
};

function readDenialNotice(): DenialNotice | null {
  if (typeof window === "undefined") return null;

  // Surfaced by GoogleAuthService when the OAuth round-trip fails (user
  // hit Deny, picked a non-renosud Google account, or the hd claim was
  // missing). Showing this banner is what breaks the otherwise infinite
  // /api/login → Google → /api/login redirect loop.
  const params = new URLSearchParams(window.location.search);
  if (params.get("error") === "auth_failed") {
    // Clean the URL so a refresh doesn't redisplay the banner.
    const url = new URL(window.location.href);
    url.searchParams.delete("error");
    window.history.replaceState({}, "", url.pathname + url.search);
    return {
      code: "auth_failed",
      message:
        "Google sign-in was cancelled or your account isn't part of the Renosud workspace. Try again with your @renosud.com account.",
      allowedDomain: null,
    };
  }

  const raw = window.sessionStorage.getItem("archisign:auth-denied");
  if (!raw) return null;
  window.sessionStorage.removeItem("archisign:auth-denied");
  try {
    const parsed = JSON.parse(raw);
    return {
      code: typeof parsed?.code === "string" ? parsed.code : "access_denied",
      message:
        typeof parsed?.message === "string"
          ? parsed.message
          : "Access denied.",
      allowedDomain:
        typeof parsed?.allowedDomain === "string" ? parsed.allowedDomain : null,
    };
  } catch {
    return { code: "access_denied", message: "Access denied.", allowedDomain: null };
  }
}

export default function LoginPage() {
  const [denial, setDenial] = useState<DenialNotice | null>(null);
  useEffect(() => {
    setDenial(readDenialNotice());
  }, []);

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      <div className="lg:w-1/2 bg-[#1e293b] flex flex-col justify-between p-8 lg:p-12 text-white">
        <div>
          <div className="flex items-center gap-3 mb-12">
            <img
              src={archisignLogo}
              alt="Archisign"
              className="h-16 w-auto object-contain"
              data-testid="img-login-logo"
            />
          </div>
          <h1 className="text-3xl lg:text-4xl font-serif font-bold mb-4 leading-tight">
            Secure Document Signing for Architecture Professionals
          </h1>
          <p className="text-slate-300 text-lg mb-10 max-w-md">
            Streamline your external sign-offs with cryptographic security, audit trails, and Gmail integration.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-lg">
            <div className="flex items-start gap-2">
              <Lock className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
              <span className="text-sm text-slate-300">SHA-256 OTP Verification</span>
            </div>
            <div className="flex items-start gap-2">
              <Eye className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
              <span className="text-sm text-slate-300">Full Audit Trail</span>
            </div>
            <div className="flex items-start gap-2">
              <FileSignature className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
              <span className="text-sm text-slate-300">Page-by-Page Initials</span>
            </div>
          </div>
        </div>
        <p className="text-xs text-slate-500 mt-8">
          Archisign — Internal Administration Platform
        </p>
      </div>

      <div className="lg:w-1/2 flex items-center justify-center p-8 lg:p-12 bg-background">
        <Card className="w-full max-w-sm p-8 text-center space-y-6">
          {denial && (
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-left"
              data-testid="banner-auth-denied"
            >
              <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <div className="text-xs text-destructive">
                <p className="font-semibold mb-1">Access denied</p>
                <p>{denial.message}</p>
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Shield className="h-10 w-10 mx-auto text-muted-foreground" />
            <h2 className="text-xl font-semibold" data-testid="text-login-heading">
              Admin Access
            </h2>
            <p className="text-sm text-muted-foreground">
              Sign in with your Renosud Google Workspace account to access the dashboard.
            </p>
          </div>
          <Button
            asChild
            className="w-full bg-[#F59E0B] text-white border-2 border-[#D97706] font-semibold"
            data-testid="button-login"
          >
            <a href="/api/login">Sign in with Google</a>
          </Button>
          <p className="text-xs text-muted-foreground" data-testid="text-login-restriction">
            Restricted to Renosud staff. Only verified
            {" "}
            <span className="font-mono">@{denial?.allowedDomain ?? "renosud.com"}</span>
            {" "}
            accounts can access this area.
          </p>
        </Card>
      </div>
    </div>
  );
}
