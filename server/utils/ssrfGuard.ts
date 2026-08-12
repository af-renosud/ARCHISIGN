/**
 * SSRF Guard — server/utils/ssrfGuard.ts
 *
 * Provides `safeFetch()`: a drop-in replacement for the global `fetch()` that
 * defends against Server-Side Request Forgery by:
 *
 *   1. Rejecting non-http/https protocols and known internal hostnames up-front.
 *   2. Resolving ALL A and AAAA records through a custom lookup function that is
 *      wired directly into the http/https agent — the same DNS call that the
 *      connection layer uses. This eliminates the TOCTOU/DNS-rebinding window
 *      because there is no second independent resolution; the connection is made
 *      to the exact IP that passed the private-range check.
 *   3. Disabling redirect following (`maxRedirects: 0`).
 *
 * Internal helpers (`isPrivateHostname`) are exported for defence-in-depth
 * callers that want a fast synchronous pre-filter on already-stored URLs.
 */

import http from "http";
import https from "https";
import dns from "dns/promises";
import net from "net";

const PRIVATE_IPV4_PATTERNS = [
  /^127\./,                                      // loopback
  /^10\./,                                       // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./,                 // RFC1918
  /^192\.168\./,                                 // RFC1918
  /^169\.254\./,                                 // link-local
  /^0\./,                                        // 0.0.0.0/8
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // CGNAT RFC6598
];

const PRIVATE_IPV6_PATTERNS = [
  /^::1$/,             // loopback
  /^fc[0-9a-f]{2}:/i, // unique local fc00::/7
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,           // link-local
  /^::$/,              // unspecified
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "metadata.internal",
]);

function isPrivateIp(ip: string): boolean {
  const bare = ip.startsWith("[") ? ip.slice(1, -1) : ip;

  if (net.isIPv4(bare)) {
    return PRIVATE_IPV4_PATTERNS.some(p => p.test(bare));
  }

  if (net.isIPv6(bare)) {
    // IPv6-mapped IPv4 — e.g. ::ffff:127.0.0.1
    const mappedDotted = bare.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (mappedDotted) {
      return PRIVATE_IPV4_PATTERNS.some(p => p.test(mappedDotted[1]));
    }
    // IPv6-mapped IPv4 in hex groups — e.g. ::ffff:7f00:0001 → 127.0.0.1
    const mappedHex = bare.match(/^::ffff:([0-9a-f]{4}):([0-9a-f]{4})$/i);
    if (mappedHex) {
      const a = parseInt(mappedHex[1], 16);
      const b = parseInt(mappedHex[2], 16);
      const v4 = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
      return PRIVATE_IPV4_PATTERNS.some(p => p.test(v4));
    }
    return PRIVATE_IPV6_PATTERNS.some(p => p.test(bare));
  }

  return false;
}

/**
 * Validates URL protocol, blocked hostnames, and literal-IP ranges.
 * For hostnames, the DNS validation is deferred to the agent's `lookup`
 * callback inside `safeFetch()` so it is pinned to the actual connection.
 *
 * @throws Error with `.httpStatus` if the URL fails static checks.
 */
function validateUrlStatically(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error(`${label}: malformed URL`), { httpStatus: 400 });
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw Object.assign(
      new Error(`${label}: only http and https URLs are permitted`),
      { httpStatus: 400 },
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw Object.assign(
      new Error(`${label}: destination host is not permitted`),
      { httpStatus: 400 },
    );
  }

  if (net.isIP(hostname) && isPrivateIp(hostname)) {
    throw Object.assign(
      new Error(`${label}: destination is a private/internal address`),
      { httpStatus: 400 },
    );
  }

  return parsed;
}

/**
 * Creates an `http.Agent` / `https.Agent` with a custom `lookup` that resolves
 * ALL A and AAAA records, checks every address for private/internal ranges, and
 * fails the connection if any is found. This is the TOCTOU-safe DNS validation
 * path: the same DNS call used for connection is the one that is validated.
 */
type Resolver = { resolve4(h: string): Promise<string[]>; resolve6(h: string): Promise<string[]> };

/**
 * Builds the safe `lookup` function installed on the agent. Exported for
 * tests; `resolver` is injectable so DNS can be stubbed.
 *
 * Note: `family`/`hints` in the lookup options are intentionally ignored —
 * `safeFetch` never sets them, and this lookup always validates and returns
 * the full A+AAAA set (or the IPv4-preferred single address in legacy shape).
 */
export function makeSafeLookup(label: string, resolver: Resolver = dns) {
  // Node's connection layer calls `lookup` in two shapes:
  //  - legacy: options without `all` → callback(err, address, family)
  //  - `{ all: true }` (used by the autoSelectFamily path, default in
  //    Node 20+) → callback(err, [{ address, family }, ...])
  // Returning a bare string when `all: true` was requested makes Node's
  // internal address validation throw "Invalid IP address: undefined",
  // which surfaced in production as vault_transient 503s. Honor both shapes.
  function safeLookup(
    hostname: string,
    opts: unknown,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void {
    const wantAll = typeof opts === "object" && opts !== null && (opts as { all?: boolean }).all === true;
    const fail = (err: NodeJS.ErrnoException) =>
      wantAll ? callback(err, []) : callback(err, "", 0);
    Promise.all([
      resolver.resolve4(hostname).catch((): string[] => []),
      resolver.resolve6(hostname).catch((): string[] => []),
    ]).then(([v4, v6]) => {
      const all: string[] = [...v4, ...v6];
      if (all.length === 0) {
        fail(Object.assign(new Error(`${label}: destination host could not be resolved`), { code: "ENOTFOUND" }));
        return;
      }
      const privateAddr = all.find(isPrivateIp);
      if (privateAddr) {
        fail(
          Object.assign(
            new Error(`${label}: destination resolves to a private/internal address`),
            { code: "ECONNREFUSED", httpStatus: 400 },
          ),
        );
        return;
      }
      if (wantAll) {
        // Every address in this list passed the private-range check above,
        // so whichever one the connection layer picks is safe.
        callback(null, [
          ...v4.map((address) => ({ address, family: 4 })),
          ...v6.map((address) => ({ address, family: 6 })),
        ]);
        return;
      }
      // Prefer IPv4 for compatibility; use first valid address.
      const addr = v4.length > 0 ? v4[0] : v6[0];
      callback(null, addr, v4.length > 0 ? 4 : 6);
    }).catch((err: Error) => fail(err as NodeJS.ErrnoException));
  }

  return safeLookup;
}

function makeAgentWithSafeLookup(
  protocol: "http:" | "https:",
  label: string,
): http.Agent | https.Agent {
  const AgentClass = protocol === "https:" ? https.Agent : http.Agent;
  return new AgentClass({ lookup: makeSafeLookup(label) as net.LookupFunction });
}

export interface SafeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Fetches `rawUrl` with full SSRF protection:
 *
 * - Static checks (protocol, blocked hostnames, literal IPs)
 * - DNS validation pinned to the connection layer (no TOCTOU gap)
 * - Redirect following disabled
 * - Request cancelled on AbortSignal
 *
 * @throws Error with `.httpStatus` if blocked; propagates network errors.
 */
export async function safeFetch(
  rawUrl: string,
  label: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  } = {},
): Promise<SafeResponse> {
  const parsed = validateUrlStatically(rawUrl, label);

  const agent = makeAgentWithSafeLookup(parsed.protocol as "http:" | "https:", label);
  const requestModule = parsed.protocol === "https:" ? https : http;

  return new Promise<SafeResponse>((resolve, reject) => {
    const reqOptions: http.RequestOptions = {
      method: options.method || "GET",
      headers: options.headers,
      agent,
    };

    const req = requestModule.request(rawUrl, reqOptions, (res) => {
      // Never follow redirects — treat 3xx as an error response.
      const status = res.statusCode ?? 0;
      const ok = status >= 200 && status < 300;

      const rawHeaders = res.headers;
      const headerGet = (name: string): string | null => {
        const val = rawHeaders[name.toLowerCase()];
        if (val === undefined) return null;
        if (Array.isArray(val)) return val[0] ?? null;
        return val;
      };

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok,
          status,
          statusText: res.statusMessage ?? "",
          headers: { get: headerGet },
          arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer),
        });
      });
      res.on("error", reject);
    });

    req.on("error", (err: NodeJS.ErrnoException & { httpStatus?: number }) => {
      // Re-attach httpStatus from the safe-lookup error (if set) so callers
      // can distinguish SSRF blocks from generic network errors.
      reject(err);
    });

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        req.destroy(
          Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }),
        );
      });
    }

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Early-rejection guard for partner-supplied URLs.
 * Checks protocol, blocked hostnames, literal IPs, and resolves ALL A/AAAA
 * records (non-pinned). Use at creation time to return a fast 400 for obvious
 * SSRF payloads; the DNS-pinned `safeFetch` is the binding-time security gate.
 *
 * @throws Error with `.httpStatus` if the URL is rejected.
 */
export async function assertSafeUrl(rawUrl: string, label: string): Promise<void> {
  const parsed = validateUrlStatically(rawUrl, label);
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (net.isIP(hostname)) return; // literal IP already checked in validateUrlStatically

  const [v4, v6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);
  const addresses: string[] = [];
  if (v4.status === "fulfilled") addresses.push(...v4.value);
  if (v6.status === "fulfilled") addresses.push(...v6.value);

  if (addresses.length === 0) {
    throw Object.assign(
      new Error(`${label}: destination host could not be resolved`),
      { httpStatus: 400 },
    );
  }
  const privateAddr = addresses.find(isPrivateIp);
  if (privateAddr) {
    throw Object.assign(
      new Error(`${label}: destination resolves to a private/internal address`),
      { httpStatus: 400 },
    );
  }
}

/**
 * Synchronous literal-IP / blocked-hostname check.
 * Does NOT perform DNS resolution. Use as a fast pre-filter on stored URLs;
 * always back with a `safeFetch` call for full DNS-pinned protection.
 */
export function isPrivateHostname(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (BLOCKED_HOSTNAMES.has(hostname)) return true;
    if (net.isIP(hostname)) return isPrivateIp(hostname);
    return false;
  } catch {
    return true;
  }
}
