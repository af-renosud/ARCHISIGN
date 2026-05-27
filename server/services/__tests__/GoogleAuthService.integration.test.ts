import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import session from "express-session";
import passport from "passport";
import type { AddressInfo } from "node:net";
import type { RequestHandler } from "express";

import {
  buildGoogleVerify,
  buildGoogleCallbackHandler,
  buildRecordSignInRejection,
  type ProjectedClaims,
} from "../GoogleAuthService";

// End-to-end integration test for the Google sign-in flow. Instead of
// standing up a real OIDC client + JWKS, we register a passport "Strategy"
// that injects a pre-staged token response into the same verify callback
// the production code uses. The callback handler, audit-on-fail wiring,
// session creation, and redirect behaviour are exercised exactly as they
// are in production — only the network round-trip to Google is faked.

interface FakeAuditEvent {
  envelopeId: number | null;
  eventType: string;
  actorEmail: string;
  ipAddress: string | null;
  metadata: string;
}

interface StagedScenario {
  // null → invoke `this.error()` so the callback handler takes the oauth_error path.
  claims: Record<string, unknown> | null;
  errorOnAuthenticate?: Error;
}

class StagedGoogleStrategy extends (passport as any).Strategy {
  name: string;
  private verify: any;
  staged: StagedScenario | null = null;

  constructor(name: string, verify: any) {
    super();
    this.name = name;
    this.verify = verify;
  }

  authenticate(req: any, _options: any) {
    // On /api/login: short-circuit to a redirect into the callback URL,
    // mimicking the trip out to Google and back.
    if (req.path === "/api/login") {
      const cb = `/api/auth/google/callback?code=stub&state=stub`;
      return (this as any).redirect(cb);
    }

    // Callback phase.
    const scenario = this.staged;
    this.staged = null;
    if (!scenario) {
      return (this as any).fail({ message: "no_scenario_staged" }, 401);
    }
    if (scenario.errorOnAuthenticate) {
      return (this as any).error(scenario.errorOnAuthenticate);
    }

    const claims = scenario.claims;
    const fakeTokens = {
      access_token: "fake-access-token",
      refresh_token: "fake-refresh-token",
      claims() {
        return claims;
      },
    };

    this.verify(fakeTokens, (err: any, user: any, info: any) => {
      if (err) return (this as any).error(err);
      if (!user) return (this as any).fail(info, 401);
      (this as any).success(user);
    });
  }
}

interface Harness {
  baseUrl: string;
  auditEvents: FakeAuditEvent[];
  upsertedUsers: ProjectedClaims[];
  strategy: StagedGoogleStrategy;
  close: () => Promise<void>;
}

async function startApp(opts: {
  allowedDomain?: string;
} = {}): Promise<Harness> {
  const domain = opts.allowedDomain ?? "renosud.com";
  const auditEvents: FakeAuditEvent[] = [];
  const upsertedUsers: ProjectedClaims[] = [];

  const app = express();
  app.set("trust proxy", 1);

  const localPassport = new (passport as any).Passport();
  app.use(
    session({
      secret: "googleAuthIntegrationTestSecret",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax" },
    }),
  );
  app.use(localPassport.initialize());
  app.use(localPassport.session());
  localPassport.serializeUser((user: any, done: any) => done(null, user));
  localPassport.deserializeUser((user: any, done: any) => done(null, user));

  const verify = buildGoogleVerify(domain, async (claims) => {
    upsertedUsers.push(claims);
  });

  const strategy = new StagedGoogleStrategy("google:test", verify);
  localPassport.use(strategy.name, strategy);

  const recordRejection = buildRecordSignInRejection({
    createAuditEvent: async (event) => {
      auditEvents.push(event);
      return event;
    },
  });

  app.get("/api/login", (req, res, next) => {
    localPassport.authenticate(strategy.name, {} as any)(req, res, next);
  });

  app.get(
    "/api/auth/google/callback",
    buildGoogleCallbackHandler({
      passportInstance: localPassport,
      resolveStrategyName: () => strategy.name,
      recordRejection,
    }),
  );

  // Stand-in for /api/auth/user — 200 iff a session exists.
  const requireSession: RequestHandler = (req, res, next) => {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    res.status(401).json({ message: "Unauthorized" });
  };
  app.get("/api/auth/user", requireSession, (req, res) => {
    res.json({ ok: true, email: (req.user as any)?.claims?.email });
  });

  return await new Promise<Harness>((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        auditEvents,
        upsertedUsers,
        strategy,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

// Cookie jar that survives across requests, like a browser would.
class CookieJar {
  private cookies = new Map<string, string>();
  ingest(setCookieHeader: string | null) {
    if (!setCookieHeader) return;
    const parts = setCookieHeader.split(/,(?=\s*[A-Za-z0-9_\-]+=)/);
    for (const part of parts) {
      const [pair] = part.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

async function call(
  baseUrl: string,
  path: string,
  jar: CookieJar,
): Promise<{
  status: number;
  location: string | null;
  body: any;
}> {
  const headers: Record<string, string> = {};
  const cookie = jar.header();
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(baseUrl + path, { headers, redirect: "manual" });
  jar.ingest(res.headers.get("set-cookie"));
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return {
    status: res.status,
    location: res.headers.get("location"),
    body,
  };
}

// Walk /api/login → 302 to callback URL → call callback → assert outcome.
async function driveOAuthRoundTrip(
  h: Harness,
  jar: CookieJar,
  scenario: StagedScenario,
): Promise<{ status: number; location: string | null }> {
  const login = await call(h.baseUrl, "/api/login", jar);
  assert.equal(
    login.status,
    302,
    "/api/login must redirect (simulating Google account chooser)",
  );
  assert.ok(login.location, "redirect must include Location header");
  assert.ok(
    login.location!.startsWith("/api/auth/google/callback"),
    `expected redirect into callback, got ${login.location}`,
  );

  // Stage the scenario for the callback hit.
  h.strategy.staged = scenario;
  const cb = await call(h.baseUrl, login.location!, jar);
  return { status: cb.status, location: cb.location };
}

function workspaceClaims(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    sub: "google-oauth2|10000001",
    email: "alice@renosud.com",
    email_verified: true,
    given_name: "Alice",
    family_name: "Renosud",
    picture: "https://example.com/alice.png",
    hd: "renosud.com",
    exp: 1_900_000_000,
    ...overrides,
  };
}

test("integration: matching hd + email succeeds, establishes a session, and upserts the user", async () => {
  const h = await startApp();
  const jar = new CookieJar();
  try {
    const result = await driveOAuthRoundTrip(h, jar, {
      claims: workspaceClaims(),
    });

    assert.equal(result.status, 302, "callback should redirect on success");
    assert.equal(result.location, "/", "successful callback redirects to /");

    // The session cookie set during the callback should authorise the
    // follow-up /api/auth/user call.
    const me = await call(h.baseUrl, "/api/auth/user", jar);
    assert.equal(me.status, 200, "follow-up /api/auth/user must be authorised");
    assert.equal(me.body.ok, true);
    assert.equal(me.body.email, "alice@renosud.com");

    assert.equal(h.upsertedUsers.length, 1, "user should be upserted exactly once");
    assert.equal(h.upsertedUsers[0].email, "alice@renosud.com");
    assert.equal(h.upsertedUsers[0].hd, "renosud.com");

    assert.equal(h.auditEvents.length, 0, "no rejection audit row on success");
  } finally {
    await h.close();
  }
});

test("integration: missing hd (personal Gmail) is rejected, redirected to /login?error=auth_failed, no session leaked", async () => {
  const h = await startApp();
  const jar = new CookieJar();
  try {
    const result = await driveOAuthRoundTrip(h, jar, {
      claims: workspaceClaims({
        email: "intruder@gmail.com",
        hd: undefined,
      }),
    });

    assert.equal(result.status, 302);
    assert.equal(
      result.location,
      "/login?error=auth_failed",
      "rejected sign-in must redirect to /login?error=auth_failed",
    );

    // The follow-up authenticated call MUST be unauthenticated — the
    // failed verify never created a session.
    const me = await call(h.baseUrl, "/api/auth/user", jar);
    assert.equal(me.status, 401, "no session may be leaked on a rejected sign-in");

    assert.equal(h.upsertedUsers.length, 0, "rejected sign-in must NOT upsert");
    assert.equal(h.auditEvents.length, 1, "one rejection audit row expected");
    const ev = h.auditEvents[0];
    assert.equal(ev.eventType, "Unauthorized admin sign-in attempt");
    assert.equal(ev.actorEmail, "intruder@gmail.com");
    assert.equal(ev.envelopeId, null);
    const meta = JSON.parse(ev.metadata);
    assert.equal(meta.reason, "hd_mismatch");
    assert.equal(meta.provider, "google");
    assert.equal(meta.hd, null);
  } finally {
    await h.close();
  }
});

test("integration: mismatched hd (other Workspace domain) is rejected, redirected to /login?error=auth_failed, no session leaked", async () => {
  const h = await startApp();
  const jar = new CookieJar();
  try {
    const result = await driveOAuthRoundTrip(h, jar, {
      claims: workspaceClaims({
        email: "alice@other-firm.com",
        hd: "other-firm.com",
      }),
    });

    assert.equal(result.status, 302);
    assert.equal(result.location, "/login?error=auth_failed");

    const me = await call(h.baseUrl, "/api/auth/user", jar);
    assert.equal(me.status, 401, "no session may be leaked on a mismatched-hd sign-in");

    assert.equal(h.upsertedUsers.length, 0);
    assert.equal(h.auditEvents.length, 1);
    const meta = JSON.parse(h.auditEvents[0].metadata);
    assert.equal(meta.reason, "hd_mismatch");
    assert.equal(meta.hd, "other-firm.com");
    assert.equal(h.auditEvents[0].actorEmail, "alice@other-firm.com");
  } finally {
    await h.close();
  }
});
