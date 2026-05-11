import type { Request, Response, NextFunction, RequestHandler } from "express";

export type RateFamily = "create" | "send" | "read" | "contacts";

const RPM_SUSTAINED = 60;
const BURST_CAPACITY = 30;
const DAILY_CAP = 5000;
const REFILL_PER_SEC = RPM_SUSTAINED / 60;
const DAY_MS = 24 * 60 * 60 * 1000;

interface BucketState {
  tokens: number;
  lastRefill: number;
  dailyUsed: number;
  dailyWindowStart: number;
}

const buckets = new Map<string, BucketState>();

function bucketKey(tenant: string, family: RateFamily): string {
  return `${tenant}::${family}`;
}

function refill(state: BucketState, now: number): void {
  const elapsedSec = (now - state.lastRefill) / 1000;
  if (elapsedSec > 0) {
    state.tokens = Math.min(BURST_CAPACITY, state.tokens + elapsedSec * REFILL_PER_SEC);
    state.lastRefill = now;
  }
  if (now - state.dailyWindowStart >= DAY_MS) {
    state.dailyUsed = 0;
    state.dailyWindowStart = now;
  }
}

export type LimitKind = "sustained" | "burst" | "daily";

export interface ConsumeResult {
  allowed: boolean;
  retryAfterSec?: number;
  limit?: LimitKind;
  currentUsage: number;
  ceiling: number;
  remaining: number;
}

export function consumeToken(tenant: string, family: RateFamily, now: number = Date.now()): ConsumeResult {
  const key = bucketKey(tenant, family);
  let state = buckets.get(key);
  if (!state) {
    state = { tokens: BURST_CAPACITY, lastRefill: now, dailyUsed: 0, dailyWindowStart: now };
    buckets.set(key, state);
  }
  refill(state, now);

  if (state.dailyUsed >= DAILY_CAP) {
    const retry = Math.ceil((state.dailyWindowStart + DAY_MS - now) / 1000);
    return {
      allowed: false,
      retryAfterSec: retry > 0 ? retry : 1,
      limit: "daily",
      currentUsage: state.dailyUsed,
      ceiling: DAILY_CAP,
      remaining: 0,
    };
  }

  if (state.tokens < 1) {
    const retry = Math.ceil((1 - state.tokens) / REFILL_PER_SEC);
    const usageInBurst = Math.floor(BURST_CAPACITY - state.tokens);
    return {
      allowed: false,
      retryAfterSec: retry > 0 ? retry : 1,
      limit: "burst",
      currentUsage: usageInBurst,
      ceiling: BURST_CAPACITY,
      remaining: 0,
    };
  }

  state.tokens -= 1;
  state.dailyUsed += 1;
  return {
    allowed: true,
    currentUsage: state.dailyUsed,
    ceiling: DAILY_CAP,
    remaining: Math.max(0, DAILY_CAP - state.dailyUsed),
  };
}

export function rateLimit(family: RateFamily): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.apiKeyAuth;
    if (!auth) {
      return res.status(500).json({ message: "rateLimit middleware requires apiKeyAuth to run first" });
    }
    const result = consumeToken(auth.tenant, family);
    if (!result.allowed) {
      const retry = result.retryAfterSec ?? 60;
      res.setHeader("Retry-After", String(retry));
      res.setHeader("X-RateLimit-Remaining", "0");
      return res.status(429).json({
        error: "rate_limit_exceeded",
        retryAfter: retry,
        limit: result.limit,
        currentUsage: result.currentUsage,
        ceiling: result.ceiling,
      });
    }
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    next();
  };
}

export function _resetBucketsForTest(): void {
  buckets.clear();
}
