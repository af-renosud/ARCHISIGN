import type { Request, Response, NextFunction, RequestHandler } from "express";

export type TenantKey = "archidoc" | "architrak";

export interface ApiKeyAuthContext {
  tenant: TenantKey;
  keyHash: string;
}

declare global {
  namespace Express {
    interface Request {
      apiKeyAuth?: ApiKeyAuthContext;
    }
  }
}

function parseCsv(value: string | undefined): string[] {
  return (value || "").split(",").map(s => s.trim()).filter(Boolean);
}

function loadKeysForTenant(tenant: TenantKey): string[] {
  if (tenant === "archidoc") {
    const keys = parseCsv(process.env.ARCHIDOC_API_KEY);
    return keys;
  }
  const keys = parseCsv(process.env.ARCHITRAK_API_KEY);
  return keys;
}

function shortHash(key: string): string {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-2)}` : "***";
}

export function matchTenant(presentedKey: string): ApiKeyAuthContext | null {
  for (const tenant of ["archidoc", "architrak"] as const) {
    const keys = loadKeysForTenant(tenant);
    for (const k of keys) {
      if (k === presentedKey) {
        return { tenant, keyHash: shortHash(k) };
      }
    }
  }
  return null;
}

export const apiKeyAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const presented = req.headers["x-api-key"];
  const key = Array.isArray(presented) ? presented[0] : presented;

  if (!key || typeof key !== "string") {
    return res.status(401).json({ message: "Missing X-API-KEY header" });
  }

  const ctx = matchTenant(key);
  if (!ctx) {
    console.warn(`[AUTH] Invalid API key on ${req.method} ${req.path}`);
    return res.status(401).json({ message: "Invalid API key" });
  }

  req.apiKeyAuth = ctx;
  next();
};
