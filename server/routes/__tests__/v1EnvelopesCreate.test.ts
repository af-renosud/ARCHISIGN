import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { storage } from "../../storage";
import { db } from "../../db";
import { ContactService } from "../../services/ContactService";
import { buildV1EnvelopesRouter } from "../v1Envelopes";

const ARCHIDOC_KEY = "archidoc-test-key";

let baseUrl = "";
let server: ReturnType<express.Application["listen"]>;

const PATCHED_STORAGE_KEYS = [
  "createEnvelope",
  "createSigner",
  "createAuditEvent",
] as const;

const originals: Record<string, any> = {};
let createdEnvelopes: any[] = [];

function installFakeStorage() {
  let envId = 0;
  let signerId = 0;
  const fake: any = {
    async createEnvelope(input: any) {
      envId += 1;
      const row = {
        id: envId,
        createdAt: new Date(),
        expiresAt: input.expiresAt ?? null,
        status: input.status ?? "draft",
        ...input,
      };
      createdEnvelopes.push(row);
      return row;
    },
    async createSigner(input: any) {
      signerId += 1;
      return { id: signerId, ...input };
    },
    async createAuditEvent(ev: any) { return ev; },
  };
  for (const k of PATCHED_STORAGE_KEYS) {
    originals[`storage.${k}`] = (storage as any)[k];
    (storage as any)[k] = fake[k].bind(fake);
  }
  // The create handler wraps writes in a db transaction; run the callback
  // directly with a throwaway executor (faked storage ignores it).
  originals["db.transaction"] = (db as any).transaction;
  (db as any).transaction = async (fn: any) => fn({});
  // bumpLastUsed touches the real DB; stub to a no-op for isolation.
  originals["ContactService.bumpLastUsed"] = ContactService.bumpLastUsed;
  (ContactService as any).bumpLastUsed = async () => {};
}

function restoreStorage() {
  for (const k of PATCHED_STORAGE_KEYS) (storage as any)[k] = originals[`storage.${k}`];
  (db as any).transaction = originals["db.transaction"];
  (ContactService as any).bumpLastUsed = originals["ContactService.bumpLastUsed"];
}

before(async () => {
  process.env.ARCHIDOC_API_KEY = ARCHIDOC_KEY;
  installFakeStorage();
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.use("/api/v1", buildV1EnvelopesRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  restoreStorage();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  createdEnvelopes = [];
});

async function create(body: any) {
  const res = await fetch(baseUrl + "/api/v1/envelopes/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": ARCHIDOC_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { status: res.status, body: json };
}

const baseRequest = {
  subject: "Plans for signature",
  signerEmail: "signer@example.com",
  signerName: "Signer One",
  pdfUrl: "https://example.com/doc.pdf",
};

test("v1 create: non-empty body persists trimmed message on the envelope", async () => {
  const r = await create({ ...baseRequest, body: "  Please review and sign.  " });
  assert.equal(r.status, 201);
  assert.equal(createdEnvelopes.length, 1);
  assert.equal(createdEnvelopes[0].message, "Please review and sign.");
});

test("v1 create: whitespace-only body persists message as null", async () => {
  const r = await create({ ...baseRequest, body: "   \n\t  " });
  assert.equal(r.status, 201);
  assert.equal(createdEnvelopes.length, 1);
  assert.equal(createdEnvelopes[0].message, null);
});

test("v1 create: omitted body persists message as null", async () => {
  const r = await create({ ...baseRequest });
  assert.equal(r.status, 201);
  assert.equal(createdEnvelopes.length, 1);
  assert.equal(createdEnvelopes[0].message, null);
});
