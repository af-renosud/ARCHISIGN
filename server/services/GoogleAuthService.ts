import * as client from "openid-client";
import {
  Strategy,
  type AuthenticateOptions,
  type StrategyOptions,
  type VerifyFunction,
} from "openid-client/passport";
import passport from "passport";
import session from "express-session";
import type { Express, Request, RequestHandler } from "express";
import memoize from "memoizee";
import connectPg from "connect-pg-simple";

import { authStorage } from "../replit_integrations/auth/storage";

const GOOGLE_ISSUER = new URL("https://accounts.google.com");
const STRATEGY_PREFIX = "google";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function allowedDomain(): string {
  return (process.env.ARCHISIGN_ALLOWED_EMAIL_DOMAIN ?? "renosud.com")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
}

const getGoogleConfig = memoize(
  async () => {
    return await client.discovery(
      GOOGLE_ISSUER,
      requiredEnv("GOOGLE_OAUTH_CLIENT_ID"),
      requiredEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    );
  },
  { maxAge: 3600 * 1000 },
);

export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });
  return session({
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: sessionTtl,
    },
  });
}

export interface ProjectedClaims {
  sub: string;
  email: string | null;
  email_verified: boolean;
  first_name: string | null;
  last_name: string | null;
  profile_image_url: string | null;
  hd: string | null;
  exp: number | undefined;
}

function projectClaims(raw: Record<string, unknown>): ProjectedClaims {
  return {
    sub: String(raw.sub),
    email: typeof raw.email === "string" ? raw.email : null,
    email_verified: raw.email_verified === true,
    first_name: typeof raw.given_name === "string" ? raw.given_name : null,
    last_name: typeof raw.family_name === "string" ? raw.family_name : null,
    profile_image_url: typeof raw.picture === "string" ? raw.picture : null,
    hd: typeof raw.hd === "string" ? raw.hd : null,
    exp: typeof raw.exp === "number" ? raw.exp : undefined,
  };
}

/**
 * Server-side verification that the Google identity belongs to the configured
 * Workspace domain. The `hd` ID-token claim is the authoritative signal —
 * it is set by Google only for Workspace accounts and is signed as part of
 * the ID token, so it can't be forged or injected via the auth URL. Personal
 * Gmail accounts never carry `hd`, so requiring it (and not falling back to
 * email-suffix matching) is what blocks an attacker who registers a
 * `renosud.com` lookalike at a free webmail provider. The email-domain
 * suffix is still required as an extra sanity check.
 *
 * Exported for unit testing.
 */
export function isDomainAuthorised(
  claims: ProjectedClaims,
  domain: string,
): boolean {
  if (!claims.email_verified) return false;
  if (!claims.hd || claims.hd.toLowerCase() !== domain) return false;
  const emailDomain = (claims.email ?? "").toLowerCase().split("@")[1] ?? "";
  if (emailDomain !== domain) return false;
  return true;
}

/**
 * Subclass that injects Google's `hd` parameter on the authorization request
 * so the account chooser is restricted to the Workspace domain. The `hd`
 * claim returned in the ID token is still re-verified server-side — the URL
 * parameter alone is not a security boundary.
 */
class GoogleHostedDomainStrategy extends Strategy {
  private readonly hd: string;

  constructor(options: StrategyOptions, verify: VerifyFunction, hd: string) {
    super(options, verify);
    this.hd = hd;
  }

  authorizationRequestParams<TOptions extends AuthenticateOptions>(
    req: Request,
    options: TOptions,
  ): URLSearchParams | Record<string, string> | undefined {
    const base = super.authorizationRequestParams(req, options);
    if (base instanceof URLSearchParams) {
      base.set("hd", this.hd);
      return base;
    }
    return { ...((base as Record<string, string>) ?? {}), hd: this.hd };
  }
}

function callbackUrl(hostname: string): string {
  return `https://${hostname}/api/auth/google/callback`;
}

async function upsertUser(claims: ProjectedClaims): Promise<void> {
  await authStorage.upsertUser({
    id: claims.sub,
    email: claims.email,
    firstName: claims.first_name,
    lastName: claims.last_name,
    profileImageUrl: claims.profile_image_url,
  });
}

export async function setupAuth(app: Express): Promise<void> {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  const config = await getGoogleConfig();
  const domain = allowedDomain();

  const verify: VerifyFunction = async (tokens, verified) => {
    try {
      const raw = (tokens as client.TokenEndpointResponse &
        client.TokenEndpointResponseHelpers).claims();
      if (!raw) {
        return verified(null, false);
      }
      const projected = projectClaims(raw as Record<string, unknown>);

      if (!isDomainAuthorised(projected, domain)) {
        console.warn(
          `[AUTH] Google sign-in rejected for ${projected.email ?? "unknown"} ` +
            `(hd=${projected.hd ?? "none"}, verified=${projected.email_verified})`,
        );
        return verified(null, false);
      }

      await upsertUser(projected);
      const user = {
        claims: projected,
        access_token: (tokens as any).access_token,
        refresh_token: (tokens as any).refresh_token,
        expires_at: projected.exp,
      };
      verified(null, user);
    } catch (err) {
      verified(err as Error);
    }
  };

  // Per-hostname strategy registration so a single OAuth client serves both
  // the Replit dev domain and the production .replit.app domain, provided
  // both redirect URIs are listed in Google Cloud Console.
  const registered = new Set<string>();
  const ensureStrategy = (hostname: string): string => {
    const name = `${STRATEGY_PREFIX}:${hostname}`;
    if (!registered.has(name)) {
      passport.use(
        name,
        new GoogleHostedDomainStrategy(
          {
            name,
            config,
            scope: "openid email profile",
            callbackURL: callbackUrl(hostname),
          },
          verify,
          domain,
        ),
      );
      registered.add(name);
    }
    return name;
  };

  passport.serializeUser((user: Express.User, cb) => cb(null, user));
  passport.deserializeUser((user: Express.User, cb) => cb(null, user));

  app.get("/api/login", (req, res, next) => {
    const name = ensureStrategy(req.hostname);
    passport.authenticate(name, {
      scope: ["openid", "email", "profile"],
      prompt: "select_account",
    } as any)(req, res, next);
  });

  app.get("/api/auth/google/callback", (req, res, next) => {
    const name = ensureStrategy(req.hostname);
    passport.authenticate(name, {
      successReturnToOrRedirect: "/",
      failureRedirect: "/login?error=auth_failed",
      failureMessage: false,
    } as any)(req, res, next);
  });

  app.get("/api/logout", (req, res) => {
    const finish = () => {
      res.clearCookie("connect.sid", { path: "/" });
      res.redirect("/login");
    };
    (req as any).logout?.((err: unknown) => {
      if (err) {
        console.warn(`[AUTH] req.logout failed during /api/logout: ${err}`);
      }
      const sess = (req as any).session;
      if (sess?.destroy) {
        sess.destroy(() => finish());
      } else {
        finish();
      }
    }) ?? finish();
  });
}

export const isAuthenticated: RequestHandler = (req, res, next) => {
  const user = req.user as { claims?: { sub?: string } } | undefined;
  if (!req.isAuthenticated || !req.isAuthenticated() || !user?.claims?.sub) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  return next();
};
