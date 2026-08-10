import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { createHash } from "crypto";
import { PDFDocument } from "pdf-lib";

/**
 * Continuation signing — end-to-end at the API level (no browser).
 *
 * Walks the full lifecycle:
 *   1. Create an admin-origin parent envelope, place fields, sign it
 *      end-to-end (OTP → initials → sign → stamp).
 *   2. "Send for further signature" → continuation child draft.
 *   3. Place fields on the child, send it, and sign it end-to-end.
 *   4. Assert the child's stamped certificate cites
 *      "Continuation of Envelope <parent>" plus the parent's document hash.
 *   5. Assert the parent's status / signed PDF / hash are untouched.
 *
 * Test seams (mirroring guided-signing-flow.spec.ts):
 *   - OTP hash is seeded directly in the DB so the real /verify-otp endpoint
 *     can be driven without Gmail delivery.
 *   - The draft→sent transition is applied in the DB so no invitation email
 *     is attempted (the /send route hard-depends on Gmail).
 */

const SHA256_OF_123456 =
  "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92";
if (createHash("sha256").update("123456").digest("hex") !== SHA256_OF_123456) {
  throw new Error("SHA-256 constant for OTP 123456 is incorrect");
}

const BASE_URL = (
  process.env.E2E_BASE_URL || "http://localhost:5000"
).replace(/\/+$/, "");
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("DATABASE_URL env var must be set for E2E");
if (process.env.E2E_AUTH_BYPASS !== "1") {
  throw new Error(
    "E2E_AUTH_BYPASS=1 must be set on the server for the continuation-signing spec",
  );
}

const TOTAL_PAGES = 3;

interface EnvelopeSigner {
  id: number;
  email: string;
  fullName: string;
  accessToken: string;
}

interface EnvelopeJson {
  id: number;
  status: string;
  subject: string;
  totalPages: number;
  signedPdfUrl: string | null;
  documentHash: string | null;
  parentEnvelopeId: number | null;
  parentDocumentHash: string | null;
  continuationSequence: number | null;
  signaturePlacementMode: string | null;
  signers: EnvelopeSigner[];
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, init);
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await api(path, init);
  if (!res.ok) {
    throw new Error(`${init?.method || "GET"} ${path} → HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function buildFixturePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= TOTAL_PAGES; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Continuation E2E Page ${i}`, { x: 50, y: 750, size: 20 });
  }
  return await doc.save();
}

/** Create an admin-origin (non-partner) draft envelope with one signer. */
async function createParentEnvelope(ts: number): Promise<EnvelopeJson> {
  const bytes = await buildFixturePdf();
  const form = new FormData();
  form.set("subject", `Continuation E2E ${ts}`);
  form.set("signaturePlacementMode", "admin_placed");
  form.set(
    "signers",
    JSON.stringify([
      { email: `continuation-parent-${ts}@example.test`, fullName: "Paula Parent" },
    ]),
  );
  form.set(
    "pdf",
    new Blob([Buffer.from(bytes)], { type: "application/pdf" }),
    "continuation-e2e.pdf",
  );
  const res = await api("/api/envelopes", { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`create parent failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as EnvelopeJson;
}

/** Admin-places one signature field for the signer on the last page. */
async function placeSignatureField(envelopeId: number, signerId: number, page: number) {
  await apiJson(`/api/envelopes/${envelopeId}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signerId,
      pageNumber: page,
      xPos: 0.3,
      yPos: 0.6,
      width: 0.4,
      height: 0.12,
      type: "signature",
    }),
  });
}

/** Test seam: draft → sent without touching Gmail. */
async function markSent(pool: Pool, envelopeId: number) {
  const r = await pool.query(
    `UPDATE envelopes SET status = 'sent' WHERE id = $1 AND status = 'draft' RETURNING id`,
    [envelopeId],
  );
  if (r.rowCount !== 1) throw new Error(`markSent affected ${r.rowCount} rows for envelope ${envelopeId}`);
  await pool.query(
    `INSERT INTO audit_events (envelope_id, event_type, actor_email, ip_address, metadata)
     VALUES ($1, 'Envelope sent for signing', NULL, NULL, NULL)`,
    [envelopeId],
  );
}

/** Test seam: seed a known OTP hash so the real /verify-otp can be driven. */
async function seedKnownOtp(pool: Pool, signerId: number) {
  const r = await pool.query(
    `UPDATE signers
       SET otp_code = $1,
           otp_expires_at = NOW() + INTERVAL '10 minutes',
           otp_issued_at = NOW()
     WHERE id = $2
       AND otp_verified = false
     RETURNING id`,
    [SHA256_OF_123456, signerId],
  );
  if (r.rowCount !== 1) throw new Error(`seedKnownOtp affected ${r.rowCount} rows for signer ${signerId}`);
}

/** OTP-verify, initial every page, then sign — the real signer journey. */
async function signEnvelopeAsSigner(
  pool: Pool,
  signer: EnvelopeSigner,
  totalPages: number,
): Promise<void> {
  await seedKnownOtp(pool, signer.id);
  await apiJson(`/api/sign/${signer.accessToken}/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "123456" }),
  });
  for (let p = 1; p <= totalPages; p++) {
    await apiJson(`/api/sign/${signer.accessToken}/initial`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageNumber: p }),
    });
  }
  const signResult = await apiJson<{ success: boolean; allSigned: boolean }>(
    `/api/sign/${signer.accessToken}/sign`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  expect(signResult.allSigned).toBe(true);
}

async function downloadSignedPdf(accessToken: string): Promise<Buffer> {
  const r = await api(`/api/sign/${accessToken}/download`);
  if (r.status !== 200) throw new Error(`download HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.subarray(0, 4).toString() !== "%PDF") throw new Error("not a PDF");
  return buf;
}

/**
 * Extract the whole text layer of a PDF (all pages, whitespace collapsed)
 * so certificate lines can be asserted regardless of layout wrapping.
 */
async function extractAllText(buf: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  let text = "";
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      for (const item of content.items as any[]) {
        if (typeof item?.str === "string") text += item.str + " ";
      }
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return text.replace(/\s+/g, " ");
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test.describe("Continuation envelope signing", () => {
  let pool: Pool;
  test.beforeAll(() => {
    pool = new Pool({ connectionString: DB_URL });
  });
  test.afterAll(async () => {
    await pool.end();
  });

  test("child signs end-to-end and its certificate cites the original; parent untouched", async () => {
    const ts = Date.now();

    // ---- 1. Parent: create → place fields → send → OTP → sign → stamp ----
    const parentDraft = await createParentEnvelope(ts);
    const parentSigner = parentDraft.signers[0];
    expect(parentDraft.status).toBe("draft");
    expect(parentDraft.totalPages).toBe(TOTAL_PAGES);

    await placeSignatureField(parentDraft.id, parentSigner.id, TOTAL_PAGES);
    await markSent(pool, parentDraft.id);
    await signEnvelopeAsSigner(pool, parentSigner, TOTAL_PAGES);

    const parentSigned = await apiJson<EnvelopeJson>(`/api/envelopes/${parentDraft.id}`);
    expect(parentSigned.status).toBe("signed");
    expect(parentSigned.signedPdfUrl).toBeTruthy();
    expect(parentSigned.documentHash).toMatch(/^[0-9a-f]{64}$/);

    // Snapshot the parent's evidence before the continuation is touched.
    const parentPdfBefore = await downloadSignedPdf(parentSigner.accessToken);
    const parentPdfHashBefore = sha256(parentPdfBefore);

    // ---- 2. Send for further signature -----------------------------------
    const child = await apiJson<EnvelopeJson>(`/api/envelopes/${parentDraft.id}/continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signers: [
          { email: `continuation-child-${ts}@example.test`, fullName: "Carl Continuer" },
        ],
      }),
    });
    expect(child.status).toBe("draft");
    expect(child.parentEnvelopeId).toBe(parentDraft.id);
    expect(child.parentDocumentHash).toBe(parentSigned.documentHash);
    // Cert pages of the parent must not count toward the child's pages.
    expect(child.totalPages).toBe(TOTAL_PAGES);
    const childSigner = child.signers[0];

    // ---- 3. Child: place fields → send → OTP → sign → stamp --------------
    await placeSignatureField(child.id, childSigner.id, child.totalPages);
    await markSent(pool, child.id);
    await signEnvelopeAsSigner(pool, childSigner, child.totalPages);

    const childSigned = await apiJson<EnvelopeJson>(`/api/envelopes/${child.id}`);
    expect(childSigned.status).toBe("signed");
    expect(childSigned.signedPdfUrl).toBeTruthy();
    expect(childSigned.signedPdfUrl).not.toBe(parentSigned.signedPdfUrl);
    expect(childSigned.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(childSigned.documentHash).not.toBe(parentSigned.documentHash);

    // ---- 4. Child certificate cites the original --------------------------
    const childPdf = await downloadSignedPdf(childSigner.accessToken);
    const childText = await extractAllText(childPdf);
    expect(childText).toContain(`Continuation of Envelope ${parentDraft.id}`);
    expect(childText).toContain(
      `Parent signed-document SHA-256: ${parentSigned.documentHash}`,
    );

    // The stamped child must carry more pages than its working document
    // (its own certificate pages were appended).
    const childDoc = await PDFDocument.load(childPdf);
    expect(childDoc.getPageCount()).toBeGreaterThan(TOTAL_PAGES);

    // ---- 5. Parent evidence is untouched ----------------------------------
    const parentAfter = await apiJson<EnvelopeJson>(`/api/envelopes/${parentDraft.id}`);
    expect(parentAfter.status).toBe("signed");
    expect(parentAfter.signedPdfUrl).toBe(parentSigned.signedPdfUrl);
    expect(parentAfter.documentHash).toBe(parentSigned.documentHash);

    const parentPdfAfter = await downloadSignedPdf(parentSigner.accessToken);
    expect(sha256(parentPdfAfter)).toBe(parentPdfHashBefore);
  });

  test("grandchild continuation cites its direct parent, increments sequence, and leaves both ancestors untouched", async () => {
    const ts = Date.now();

    // ---- 1. Original: create → place fields → send → sign ----------------
    const originalDraft = await createParentEnvelope(ts);
    const originalSigner = originalDraft.signers[0];
    await placeSignatureField(originalDraft.id, originalSigner.id, TOTAL_PAGES);
    await markSent(pool, originalDraft.id);
    await signEnvelopeAsSigner(pool, originalSigner, TOTAL_PAGES);

    const originalSigned = await apiJson<EnvelopeJson>(`/api/envelopes/${originalDraft.id}`);
    expect(originalSigned.status).toBe("signed");
    expect(originalSigned.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(originalSigned.continuationSequence ?? 0).toBe(0);

    // ---- 2. First continuation (child): continue → sign ------------------
    const child = await apiJson<EnvelopeJson>(`/api/envelopes/${originalDraft.id}/continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signers: [
          { email: `continuation-child-${ts}@example.test`, fullName: "Carl Continuer" },
        ],
      }),
    });
    expect(child.parentEnvelopeId).toBe(originalDraft.id);
    expect(child.parentDocumentHash).toBe(originalSigned.documentHash);
    expect(child.continuationSequence).toBe(1);
    const childSigner = child.signers[0];

    await placeSignatureField(child.id, childSigner.id, child.totalPages);
    await markSent(pool, child.id);
    await signEnvelopeAsSigner(pool, childSigner, child.totalPages);

    const childSigned = await apiJson<EnvelopeJson>(`/api/envelopes/${child.id}`);
    expect(childSigned.status).toBe("signed");
    expect(childSigned.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(childSigned.documentHash).not.toBe(originalSigned.documentHash);

    // Snapshot both ancestors' evidence before the grandchild is created.
    const originalPdfBefore = await downloadSignedPdf(originalSigner.accessToken);
    const originalPdfHashBefore = sha256(originalPdfBefore);
    const childPdfBefore = await downloadSignedPdf(childSigner.accessToken);
    const childPdfHashBefore = sha256(childPdfBefore);

    // ---- 3. Second continuation (grandchild): continue the child ---------
    const grandchild = await apiJson<EnvelopeJson>(`/api/envelopes/${child.id}/continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signers: [
          { email: `continuation-grandchild-${ts}@example.test`, fullName: "Greta Grand" },
        ],
      }),
    });
    expect(grandchild.status).toBe("draft");
    // Lineage: the grandchild pins its DIRECT parent (the child), not the original.
    expect(grandchild.parentEnvelopeId).toBe(child.id);
    expect(grandchild.parentDocumentHash).toBe(childSigned.documentHash);
    expect(grandchild.parentDocumentHash).not.toBe(originalSigned.documentHash);
    expect(grandchild.continuationSequence).toBe(2);
    // The child's cert pages must be stripped from the grandchild's working doc.
    expect(grandchild.totalPages).toBe(TOTAL_PAGES);
    const grandchildSigner = grandchild.signers[0];

    // ---- 4. Grandchild: place fields → send → sign → stamp ---------------
    await placeSignatureField(grandchild.id, grandchildSigner.id, grandchild.totalPages);
    await markSent(pool, grandchild.id);
    await signEnvelopeAsSigner(pool, grandchildSigner, grandchild.totalPages);

    const grandchildSigned = await apiJson<EnvelopeJson>(`/api/envelopes/${grandchild.id}`);
    expect(grandchildSigned.status).toBe("signed");
    expect(grandchildSigned.signedPdfUrl).toBeTruthy();
    expect(grandchildSigned.signedPdfUrl).not.toBe(childSigned.signedPdfUrl);
    expect(grandchildSigned.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(grandchildSigned.documentHash).not.toBe(childSigned.documentHash);
    expect(grandchildSigned.documentHash).not.toBe(originalSigned.documentHash);
    expect(grandchildSigned.continuationSequence).toBe(2);

    // ---- 5. Grandchild certificate cites the child, not the original -----
    const grandchildPdf = await downloadSignedPdf(grandchildSigner.accessToken);
    const grandchildText = await extractAllText(grandchildPdf);
    expect(grandchildText).toContain(`Continuation of Envelope ${child.id}`);
    expect(grandchildText).toContain(
      `Parent signed-document SHA-256: ${childSigned.documentHash}`,
    );
    expect(grandchildText).not.toContain(`Continuation of Envelope ${originalDraft.id}`);
    expect(grandchildText).not.toContain(
      `Parent signed-document SHA-256: ${originalSigned.documentHash}`,
    );

    const grandchildDoc = await PDFDocument.load(grandchildPdf);
    expect(grandchildDoc.getPageCount()).toBeGreaterThan(TOTAL_PAGES);

    // ---- 6. Both ancestors' evidence is untouched -------------------------
    const originalAfter = await apiJson<EnvelopeJson>(`/api/envelopes/${originalDraft.id}`);
    expect(originalAfter.status).toBe("signed");
    expect(originalAfter.signedPdfUrl).toBe(originalSigned.signedPdfUrl);
    expect(originalAfter.documentHash).toBe(originalSigned.documentHash);
    expect(sha256(await downloadSignedPdf(originalSigner.accessToken))).toBe(
      originalPdfHashBefore,
    );

    const childAfter = await apiJson<EnvelopeJson>(`/api/envelopes/${child.id}`);
    expect(childAfter.status).toBe("signed");
    expect(childAfter.signedPdfUrl).toBe(childSigned.signedPdfUrl);
    expect(childAfter.documentHash).toBe(childSigned.documentHash);
    expect(sha256(await downloadSignedPdf(childSigner.accessToken))).toBe(
      childPdfHashBefore,
    );
  });
});
