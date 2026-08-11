import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { seedDatabase } from "./seed";
import { pool } from "./db";
import { startSchedulers, stopSchedulers } from "./jobs/scheduler";
import { validateV2TenantConfig } from "./services/WebhookSignature";

// Cold-start timing: measured from process start (Node's own start, which
// includes module evaluation) rather than from this line, so the logged
// number reflects what a caller actually waits after the platform spawns us.
const BOOT_START_MS = performance.timeOrigin;
const sinceBoot = () => Math.round(performance.now());

const app = express();
const httpServer = createServer(app);

// Instant, dependency-free health endpoint — registered before every other
// middleware (body parsers, auth, logging) so it costs microseconds and can
// be used to cheaply warm the service after an idle period. No DB access.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", uptimeMs: sinceBoot() });
});

// Readiness gate: the port is bound immediately at boot (see below), before
// routes/auth are registered. Any request that arrives during those few
// hundred milliseconds waits here for initialization instead of 404ing.
// The queue is bounded (count + deadline) so a slow initialization can't be
// used to pile up unbounded sockets/bodies; overflow gets 503 + Retry-After.
let resolveReady: () => void;
let readyRejected: Error | null = null;
const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
let isReady = false;
const MAX_PARKED_REQUESTS = 100;
const PARK_DEADLINE_MS = 15_000;
let parkedCount = 0;
app.use((req, res, next) => {
  if (isReady) return next();
  const unavailable = () =>
    res.headersSent ? undefined : res.status(503).set("Retry-After", "2").json({ message: "Server is starting up, retry shortly" });
  if (readyRejected) return res.status(503).json({ message: "Server failed to initialize" });
  if (parkedCount >= MAX_PARKED_REQUESTS) return unavailable();

  parkedCount++;
  let settled = false;
  const settle = (fn?: () => void) => {
    if (settled) return;
    settled = true;
    parkedCount--;
    clearTimeout(deadline);
    req.off("close", onClose);
    fn?.();
  };
  const deadline = setTimeout(() => settle(unavailable), PARK_DEADLINE_MS);
  deadline.unref();
  // Client gave up while parked — drop the request without calling next().
  const onClose = () => settle();
  req.on("close", onClose);

  void ready.then(() => {
    settle(() => {
      if (res.writableEnded || res.destroyed) return;
      if (readyRejected) {
        if (!res.headersSent) res.status(503).json({ message: "Server failed to initialize" });
        return;
      }
      next();
    });
  });
});

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// v1.3 §8: contacts bulk has its own 5 MiB body cap; parse it BEFORE the global 25mb parser
// so the per-byte limit is actually enforced. Once parsed, the global parser short-circuits.
app.use(
  "/api/v1/contacts/archidoc/bulk",
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use((err: any, _req: any, res: any, next: any) => {
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({ error: "payload_too_large", message: "Body exceeds 5 MiB", limit: { kind: "byte_size", ceiling: 5 * 1024 * 1024 } });
  }
  return next(err);
});

app.use(
  express.json({
    limit: "25mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

const SENSITIVE_KEYS = new Set([
  "accessToken", "access_token", "otpCode", "otp_code",
  "otpExpiresAt", "otp_expires_at", "token", "password",
  "secret", "authorization",
]);

function redactSensitive(obj: unknown, depth = 0): unknown {
  if (depth > 5 || obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => redactSensitive(item, depth + 1));
  }
  if (typeof obj === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key)) {
        redacted[key] = "[REDACTED]";
      } else {
        redacted[key] = redactSensitive(value, depth + 1);
      }
    }
    return redacted;
  }
  return obj;
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(redactSensitive(capturedJsonResponse))}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Bind the port FIRST, before any route registration or optional
  // initialization, so the platform health check and the first real request
  // aren't stuck waiting on startup work. Requests that land before routes
  // exist are parked by the readiness gate above.
  const port = parseInt(process.env.PORT || "5000", 10);
  await new Promise<void>((resolve) => {
    httpServer.listen({ port, host: "0.0.0.0", reusePort: true }, () => {
      log(`port ${port} open in ${sinceBoot()}ms (process start ${new Date(BOOT_START_MS).toISOString()})`, "boot");
      resolve();
    });
  });

  try {
  validateV2TenantConfig((msg) => log(msg, "webhook"));

  await registerRoutes(httpServer, app);

  // Seeding stays a readiness prerequisite: it creates the uploads/backups
  // directories and default settings that routes depend on. It is idempotent
  // and cheap (a few queries) — the expensive network work (OIDC discovery,
  // googleapis) is what got moved out of the boot path, not this.
  try {
    await seedDatabase();
  } catch (err) {
    console.error("Seed error:", err);
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json(err.code ? { message, code: err.code } : { message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  } catch (err: any) {
    // Initialization failed after the port opened: release parked requests
    // with an explicit 503 instead of letting them hang forever.
    readyRejected = err instanceof Error ? err : new Error(String(err));
    resolveReady!();
    console.error("Startup initialization failed:", err);
    process.exitCode = 1;
    throw err;
  }

  // Routes and static serving are in place — release any parked requests.
  isReady = true;
  resolveReady!();
  log(`ready to serve requests in ${sinceBoot()}ms`, "boot");

  // Periodic jobs are not needed to serve requests (and internally delay
  // their first run by 30s), so they start after the gate opens.
  startSchedulers();

  let shuttingDown = false;
  async function gracefulShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received – shutting down gracefully`);

    stopSchedulers();

    httpServer.close(() => {
      log("HTTP server closed");
    });

    try {
      await pool.end();
      log("Database pool closed");
    } catch (err) {
      console.error("Error closing database pool:", err);
    }

    setTimeout(() => {
      console.error("Forced shutdown after timeout");
      process.exit(1);
    }, 10000).unref();
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
})();
