import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import session from "express-session";
import passport from "passport";
import type { AddressInfo } from "node:net";
import type { RequestHandler } from "express";
import { buildAdminGuard } from "../adminGuard";

interface FakeAuditEvent {
  envelopeId: number | null;
  eventType: string;
  actorEmail: string;
  ipAddress: string | null;
  metadata: string;
}

interface Harness {
  baseUrl: string;
  auditEvents: FakeAuditEvent[];
  close: () => Promise<void>;
}

// Build a real Express + express-session + passport harness so that the
// guard's req.logout() and req.session.destroy() calls actually destroy the
// underlying session record. That lets the "follow-up request after deny is
// unauthenticated" test reuse the same cookie jar and observe a real 401.
async function startApp(opts: {
  allowedEmailDomain?: string;
  adminEmails?: string;
}): Promise<Harness> {
  const auditEvents: FakeAuditEvent[] = [];
  const app = express();

  // Per-app passport instance to avoid global-state bleed across tests.
  const localPassport = new (passport as any).Passport();
  localPassport.serializeUser((user: any, done: any) => done(null, user));
  localPassport.deserializeUser((user: any, done: any) => done(null, user));

  app.use(
    session({
      secret: "adminGuardTestSecret",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax" },
    }),
  );
  app.use(localPassport.initialize());
  app.use(localPassport.session());

  // Login endpoint — exempted from the guard via the /api/login allowlist
  // inside buildAdminGuard. Establishes a real passport session for any email
  // by calling req.login() directly (no Strategy needed).
  app.get("/api/login", (req, res, next) => {
    const email = (req.query as any)?.email as string | undefined;
    if (!email) return res.status(400).json({ message: "email required" });
    const user = { claims: { sub: `user-${email}`, email } };
    (req as any).login(user, (err: unknown) => {
      if (err) return next(err);
      res.json({ loggedIn: true });
    });
  });

  // Guard uses the real `req.isAuthenticated()` injected by passport.
  const isAuthenticatedStub: RequestHandler = (req, res, next) => {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    res.status(401).json({ message: "Unauthorized" });
  };

  app.use(
    buildAdminGuard(
      {
        isAuthenticated: isAuthenticatedStub,
        createAuditEvent: async (event) => {
          auditEvents.push(event);
          return event;
        },
      },
      {
        allowedEmailDomain: opts.allowedEmailDomain ?? "renosud.com",
        adminEmails: opts.adminEmails ?? "",
        e2eBypass: false,
      },
    ),
  );

  // Stand-in for /api/auth/user — a 200 here means the request passed the guard.
  app.get("/api/auth/user", (req, res) => {
    res.json({ ok: true, email: (req.user as any)?.claims?.email });
  });

  app.get("/api/envelopes", (_req, res) => res.json([]));

  return await new Promise<Harness>((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        auditEvents,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

// Tiny cookie jar — keeps the most recent value per cookie name and serialises
// them back into a single Cookie header. Simulates a browser persisting the
// connect.sid cookie across requests.
class CookieJar {
  private cookies = new Map<string, string>();

  ingest(setCookieHeader: string | null) {
    if (!setCookieHeader) return;
    // Split on commas only when followed by a cookie-name=value pair, to avoid
    // splitting Expires=... commas. Node fetch returns concatenated values.
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

async function call(baseUrl: string, path: string, jar: CookieJar) {
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
  return { status: res.status, body, setCookie: res.headers.get("set-cookie") };
}

test("admin guard: non-renosud user is denied with code domain_not_allowed AND a follow-up request on the same session is unauthenticated", async () => {
  const h = await startApp({});
  const jar = new CookieJar();
  try {
    // 1. Establish an authenticated session as a non-renosud user.
    const login = await call(h.baseUrl, "/api/login?email=intruder@example.com", jar);
    assert.equal(login.status, 200, "login should succeed (login route is exempt)");
    assert.ok(jar.header(), "session cookie should be set after login");

    // 2. Hit a guarded endpoint — must be denied with the §domain_not_allowed contract.
    const denied = await call(h.baseUrl, "/api/auth/user", jar);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "domain_not_allowed");
    assert.equal(denied.body.allowedDomain, "renosud.com");

    // Audit event recorded with reason=domain_mismatch.
    assert.equal(h.auditEvents.length, 1);
    const ev = h.auditEvents[0];
    assert.equal(ev.eventType, "Unauthorized admin access attempt");
    assert.equal(ev.actorEmail, "intruder@example.com");
    assert.equal(ev.envelopeId, null);
    const meta = JSON.parse(ev.metadata);
    assert.equal(meta.reason, "domain_mismatch");
    assert.equal(meta.path, "/api/auth/user");
    assert.equal(meta.method, "GET");

    // Set-Cookie clears connect.sid so the browser drops the cookie.
    assert.ok(denied.setCookie, "expected Set-Cookie on deny");
    assert.match(denied.setCookie!, /connect\.sid=;/);

    // 3. Follow-up request on the SAME jar — the deny path called req.logout()
    //    + req.session.destroy(), so even if the browser still presented the
    //    old cookie value, the server-side session record is gone and the
    //    request must be unauthenticated.
    const followUpJar = new CookieJar();
    // Replay the cookie value the browser had just before the deny cleared it.
    followUpJar.ingest(login.setCookie);
    const followUp = await call(h.baseUrl, "/api/auth/user", followUpJar);
    // The session is gone — the request hits isAuthenticated() === false
    // and returns 401 from the stub. It must NOT be a 200 (passing the
    // guard) and the audit log must NOT have grown by a second
    // domain_mismatch row.
    assert.equal(followUp.status, 401, "follow-up on the destroyed session must be unauthenticated");
    assert.equal(h.auditEvents.length, 1, "no extra audit row from the follow-up request");
  } finally {
    await h.close();
  }
});

test("admin guard: @renosud.com user passes the guard", async () => {
  const h = await startApp({});
  const jar = new CookieJar();
  try {
    const login = await call(h.baseUrl, "/api/login?email=alice@renosud.com", jar);
    assert.equal(login.status, 200);

    const res = await call(h.baseUrl, "/api/auth/user", jar);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.email, "alice@renosud.com");
    assert.equal(h.auditEvents.length, 0);
  } finally {
    await h.close();
  }
});

test("admin guard: ADMIN_EMAILS narrows further — renosud user not on allowlist is denied with email_not_in_allowlist", async () => {
  const h = await startApp({
    adminEmails: "alice@renosud.com,carol@renosud.com",
  });
  const jar = new CookieJar();
  try {
    const login = await call(h.baseUrl, "/api/login?email=bob@renosud.com", jar);
    assert.equal(login.status, 200);

    const res = await call(h.baseUrl, "/api/auth/user", jar);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "email_not_in_allowlist");

    assert.equal(h.auditEvents.length, 1);
    const meta = JSON.parse(h.auditEvents[0].metadata);
    assert.equal(meta.reason, "email_not_in_allowlist");
    assert.equal(h.auditEvents[0].actorEmail, "bob@renosud.com");
  } finally {
    await h.close();
  }
});

test("admin guard: ADMIN_EMAILS — renosud user on the allowlist passes", async () => {
  const h = await startApp({
    adminEmails: "alice@renosud.com,carol@renosud.com",
  });
  const jar = new CookieJar();
  try {
    const login = await call(h.baseUrl, "/api/login?email=alice@renosud.com", jar);
    assert.equal(login.status, 200);
    const res = await call(h.baseUrl, "/api/auth/user", jar);
    assert.equal(res.status, 200);
    assert.equal(h.auditEvents.length, 0);
  } finally {
    await h.close();
  }
});

test("admin guard: unauthenticated request gets 401, no audit event", async () => {
  const h = await startApp({});
  try {
    const res = await call(h.baseUrl, "/api/envelopes", new CookieJar());
    assert.equal(res.status, 401);
    assert.equal(h.auditEvents.length, 0);
  } finally {
    await h.close();
  }
});
