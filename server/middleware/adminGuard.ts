import type { RequestHandler } from "express";

export interface AdminGuardDeps {
  isAuthenticated: RequestHandler;
  createAuditEvent: (event: {
    envelopeId: number | null;
    eventType: string;
    actorEmail: string;
    ipAddress: string | null;
    metadata: string;
  }) => Promise<unknown>;
}

export interface AdminGuardOptions {
  allowedEmailDomain?: string;
  adminEmails?: string;
  e2eBypass?: boolean;
}

export function buildAdminGuard(
  deps: AdminGuardDeps,
  options: AdminGuardOptions = {},
): RequestHandler {
  const ALLOWED_EMAIL_DOMAIN = (
    options.allowedEmailDomain ??
    process.env.ARCHISIGN_ALLOWED_EMAIL_DOMAIN ??
    "renosud.com"
  )
    .trim()
    .toLowerCase()
    .replace(/^@/, "");

  const guard: RequestHandler = (req, res, next) => {
    const p = req.path;
    if (p.startsWith("/api/sign/")) return next();
    if (p.startsWith("/api/v1/")) return next();
    if (p === "/api/login" || p === "/api/logout" || p === "/api/callback") {
      return next();
    }
    if (p.startsWith("/uploads")) return next();
    if (!p.startsWith("/api/")) return next();

    return deps.isAuthenticated(req, res, () => {
      const user = req.user as any;
      const userEmail: string | undefined = user?.claims?.email;
      const normEmail = (userEmail || "").trim().toLowerCase();

      const deny = (reason: "domain_mismatch" | "email_not_in_allowlist") => {
        console.warn(
          `[AUTH] Unauthorized admin access attempt by ${userEmail || "unknown"} on ${req.method} ${req.path} (${reason})`,
        );
        deps
          .createAuditEvent({
            envelopeId: null,
            eventType: "Unauthorized admin access attempt",
            actorEmail: userEmail || "unknown",
            ipAddress: req.ip || null,
            metadata: JSON.stringify({
              path: req.path,
              method: req.method,
              reason,
              allowedDomain: ALLOWED_EMAIL_DOMAIN,
            }),
          })
          .catch(() => {});

        const code =
          reason === "domain_mismatch" ? "domain_not_allowed" : "email_not_in_allowlist";
        const message =
          reason === "domain_mismatch"
            ? `Access denied. Archisign is restricted to @${ALLOWED_EMAIL_DOMAIN} accounts.`
            : "Access denied. Your account is not on the admin allowlist.";

        const finish = () => {
          res.clearCookie("connect.sid", { path: "/" });
          res.status(403).json({ code, message, allowedDomain: ALLOWED_EMAIL_DOMAIN });
        };

        const destroySession = () => {
          if (typeof (req as any).session?.destroy === "function") {
            (req as any).session.destroy((destroyErr: unknown) => {
              if (destroyErr) {
                console.warn(`[AUTH] session.destroy failed during deny path: ${destroyErr}`);
              }
              finish();
            });
          } else {
            finish();
          }
        };

        if (typeof (req as any).logout === "function") {
          (req as any).logout((logoutErr: unknown) => {
            if (logoutErr) {
              console.warn(`[AUTH] req.logout failed during deny path: ${logoutErr}`);
            }
            destroySession();
          });
        } else {
          destroySession();
        }
      };

      const isE2EBypass =
        options.e2eBypass ??
        (process.env.E2E_AUTH_BYPASS === "1" &&
          (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test"));

      if (!isE2EBypass && (!normEmail || !normEmail.endsWith("@" + ALLOWED_EMAIL_DOMAIN))) {
        return deny("domain_mismatch");
      }

      const allowedEmailsRaw = options.adminEmails ?? process.env.ADMIN_EMAILS ?? "";
      const allowedEmails = allowedEmailsRaw
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);

      if (allowedEmails.length > 0 && !allowedEmails.includes(normEmail)) {
        return deny("email_not_in_allowlist");
      }

      next();
    });
  };

  return guard;
}
