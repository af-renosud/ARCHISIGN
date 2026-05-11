import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { seedDatabase } from "./seed";
import { pool } from "./db";
import { startSchedulers, stopSchedulers } from "./jobs/scheduler";
import { validateV2TenantConfig } from "./services/WebhookSignature";

const app = express();
const httpServer = createServer(app);

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
  validateV2TenantConfig((msg) => log(msg, "webhook"));

  await registerRoutes(httpServer, app);

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

    return res.status(status).json({ message });
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

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      startSchedulers();
    },
  );

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
