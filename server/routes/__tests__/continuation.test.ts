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

test("GET /lineage: chain returns full ancestry and descendants 3 levels deep", async () => {
  // 42 (root) -> 100 -> 200 -> 300
  envelopesById[200] = { id: 200, subject: "Grandchild", status: "signed", createdAt: new Date(), parentEnvelopeId: 100, deletedAt: null };
  envelopesById[300] = { id: 300, subject: "Great-grandchild", status: "sent", createdAt: new Date(), parentEnvelopeId: 200, deletedAt: null };
  continuationsByParent[42] = [envelopesById[100]];
  continuationsByParent[100] = [envelopesById[200]];
  continuationsByParent[200] = [envelopesById[300]];

  // Query from the middle of the chain.
  const res = await fetch(`${baseUrl}/api/envelopes/200/lineage`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.chain.map((e: any) => e.id), [42, 100, 200, 300]);
  assert.deepEqual(body.chain.map((e: any) => e.depth), [0, 1, 2, 3]);
  assert.deepEqual(body.chain.map((e: any) => e.isCurrent), [false, false, true, false]);
  assert.equal(body.chain[0].subject, "Parent");
  assert.equal(body.chain[3].status, "sent");

  // Query from the root: same chain, root marked current.
  const resRoot = await fetch(`${baseUrl}/api/envelopes/42/lineage`);
  const bodyRoot = await resRoot.json();
  assert.deepEqual(bodyRoot.chain.map((e: any) => e.id), [42, 100, 200, 300]);
  assert.equal(bodyRoot.chain[0].isCurrent, true);

  // Query from the leaf: same chain, leaf marked current.
  const resLeaf = await fetch(`${baseUrl}/api/envelopes/300/lineage`);
  const bodyLeaf = await resLeaf.json();
  assert.deepEqual(bodyLeaf.chain.map((e: any) => e.id), [42, 100, 200, 300]);
  assert.equal(bodyLeaf.chain[3].isCurrent, true);
});

test("GET /lineage: very deep chains (60+ rounds) are returned in full, from root and from leaf", async () => {
  // Linear chain: 1000 -> 1001 -> ... -> 1060 (61 envelopes, depth 60).
  const DEPTH = 60;
  for (let i = 0; i <= DEPTH; i++) {
    const eid = 1000 + i;
    envelopesById[eid] = {
      id: eid, subject: `Round ${i}`, status: i === DEPTH ? "sent" : "signed",
      createdAt: new Date(), parentEnvelopeId: i === 0 ? null : eid - 1, deletedAt: null,
    };
    if (i > 0) continuationsByParent[eid - 1] = [envelopesById[eid]];
  }
  const expectedIds = Array.from({ length: DEPTH + 1 }, (_, i) => 1000 + i);

  const fromLeaf = await (await fetch(`${baseUrl}/api/envelopes/${1000 + DEPTH}/lineage`)).json();
  assert.deepEqual(fromLeaf.chain.map((e: any) => e.id), expectedIds);
  assert.equal(fromLeaf.chain[0].id, 1000); // root visible from the deep leaf
  assert.equal(fromLeaf.chain[DEPTH].isCurrent, true);

  const fromRoot = await (await fetch(`${baseUrl}/api/envelopes/1000/lineage`)).json();
  assert.deepEqual(fromRoot.chain.map((e: any) => e.id), expectedIds);
  assert.equal(fromRoot.chain[DEPTH].id, 1000 + DEPTH); // deepest leaf visible from root
  assert.equal(fromRoot.chain[0].isCurrent, true);

  const fromMiddle = await (await fetch(`${baseUrl}/api/envelopes/1030/lineage`)).json();
  assert.deepEqual(fromMiddle.chain.map((e: any) => e.id), expectedIds);
  assert.equal(fromMiddle.chain[30].isCurrent, true);
});

test("GET /lineage: cyclic parent links terminate and return each envelope once", async () => {
  // Corrupt data: 500 <-> 501 point at each other.
  envelopesById[500] = { id: 500, subject: "A", status: "signed", createdAt: new Date(), parentEnvelopeId: 501, deletedAt: null };
  envelopesById[501] = { id: 501, subject: "B", status: "signed", createdAt: new Date(), parentEnvelopeId: 500, deletedAt: null };
  continuationsByParent[500] = [envelopesById[501]];
  continuationsByParent[501] = [envelopesById[500]];

  const body = await (await fetch(`${baseUrl}/api/envelopes/500/lineage`)).json();
  const ids = body.chain.map((e: any) => e.id);
  assert.deepEqual([...new Set(ids)].sort(), ids.sort());
  assert.ok(ids.includes(500));
});

test("GET /lineage: chain has a single entry for an unlinked envelope", async () => {
  const res = await fetch(`${baseUrl}/api/envelopes/42/lineage`);
  const body = await res.json();
  assert.deepEqual(body.chain.map((e: any) => e.id), [42]);
  assert.equal(body.chain[0].isCurrent, true);
});

test("GET /lineage: soft-deleted parent is hidden; missing envelope is 404", async () => {
  envelopesById[42].deletedAt = new Date();
  const res = await fetch(`${baseUrl}/api/envelopes/100/lineage`);
  const body = await res.json();
  assert.equal(body.parent, null);

  const res2 = await fetch(`${baseUrl}/api/envelopes/999/lineage`);
  assert.equal(res2.status, 404);
});
