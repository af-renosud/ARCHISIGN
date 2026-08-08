import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { buildContinueHandler, buildLineageHandler } from "../continuation";
import { ContinuationError } from "../../services/ContinuationService";
import { validateId } from "../../middleware/validators";

let baseUrl = "";
let server: ReturnType<express.Application["listen"]>;

// Swappable fakes, reset before each test.
let createCalls: any[] = [];
let createImpl: (input: any) => Promise<any> = async () => ({ id: 100 });
let bumpedEmails: string[][] = [];
let envelopesById: Record<number, any> = {};
let continuationsByParent: Record<number, any[]> = {};

const fakeStorage = {
  async getEnvelope(id: number) {
    return envelopesById[id];
  },
  async getEnvelopeContinuations(id: number) {
    return continuationsByParent[id] ?? [];
  },
} as any;

before(async () => {
  const app = express();
  app.use(express.json());
  app.post(
    "/api/envelopes/:id/continue",
    validateId,
    buildContinueHandler({
      storage: fakeStorage,
      createContinuationEnvelope: (input: any) => {
        createCalls.push(input);
        return createImpl(input);
      },
      bumpContactsLastUsed: async (emails) => {
        bumpedEmails.push(emails);
      },
    }),
  );
  app.get(
    "/api/envelopes/:id/lineage",
    validateId,
    buildLineageHandler({ storage: fakeStorage }),
  );
  // Mirror the app-level error mapping enough that unexpected throws surface.
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ message: err.message });
  });
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => server.close());

beforeEach(() => {
  createCalls = [];
  bumpedEmails = [];
  createImpl = async () => ({ id: 100 });
  envelopesById = {
    100: { id: 100, subject: "Child", status: "draft", createdAt: new Date(), parentEnvelopeId: 42, deletedAt: null },
    42: { id: 42, subject: "Parent", status: "signed", createdAt: new Date(), parentEnvelopeId: null, deletedAt: null },
  };
  continuationsByParent = {};
});

const validBody = { signers: [{ email: "new@ex.com", fullName: "New Signer" }] };

test("POST /continue: 201 with the created child, passes actor context, bumps contacts", async () => {
  const res = await fetch(`${baseUrl}/api/envelopes/42/continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validBody),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.id, 100);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].parentEnvelopeId, 42);
  assert.deepEqual(createCalls[0].signers, validBody.signers);
  assert.deepEqual(bumpedEmails, [["new@ex.com"]]);
});

test("POST /continue: 400 on invalid body, service never called", async () => {
  for (const bad of [{}, { signers: [] }, { signers: [{ email: "not-an-email", fullName: "X" }] }]) {
    const res = await fetch(`${baseUrl}/api/envelopes/42/continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bad),
    });
    assert.equal(res.status, 400);
  }
  assert.equal(createCalls.length, 0);
});

test("POST /continue: maps ContinuationError codes to their HTTP statuses", async () => {
  const cases: [string, number][] = [
    ["parent_not_found", 404],
    ["parent_not_signed", 409],
    ["parent_api_origin", 409],
    ["parent_pdf_unavailable", 409],
  ];
  for (const [code, status] of cases) {
    createImpl = async () => {
      throw new ContinuationError(code as any, `err ${code}`, status);
    };
    const res = await fetch(`${baseUrl}/api/envelopes/42/continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    assert.equal(res.status, status, code);
    const body = await res.json();
    assert.equal(body.code, code);
  }
});

test("POST /continue: unexpected errors propagate to the app error handler (500)", async () => {
  createImpl = async () => {
    throw new Error("boom");
  };
  const res = await fetch(`${baseUrl}/api/envelopes/42/continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validBody),
  });
  assert.equal(res.status, 500);
});

test("GET /lineage: returns parent summary and continuations", async () => {
  continuationsByParent[42] = [
    { id: 100, subject: "Child", status: "draft", createdAt: new Date() },
  ];
  const res = await fetch(`${baseUrl}/api/envelopes/100/lineage`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.parent.id, 42);
  assert.equal(body.parent.subject, "Parent");
  const res2 = await fetch(`${baseUrl}/api/envelopes/42/lineage`);
  const body2 = await res2.json();
  assert.equal(body2.parent, null);
  assert.equal(body2.continuations.length, 1);
  assert.equal(body2.continuations[0].id, 100);
});

test("GET /lineage: soft-deleted parent is hidden; missing envelope is 404", async () => {
  envelopesById[42].deletedAt = new Date();
  const res = await fetch(`${baseUrl}/api/envelopes/100/lineage`);
  const body = await res.json();
  assert.equal(body.parent, null);

  const res2 = await fetch(`${baseUrl}/api/envelopes/999/lineage`);
  assert.equal(res2.status, 404);
});
