import { test } from "node:test";
import assert from "node:assert/strict";
import { autoPlaceFooterInitials } from "../InitialPlacementService";
import type { Envelope, Signer } from "@shared/schema";

function envelopeWith(originalPdfUrl: string | null): Envelope & { signers: Signer[] } {
  return { id: 1, originalPdfUrl, signers: [] } as unknown as Envelope & { signers: Signer[] };
}

test("auto-initials: missing PDF -> 400 pdf_missing", async () => {
  await assert.rejects(
    () => autoPlaceFooterInitials(envelopeWith(null)),
    (err: any) => err.status === 400 && err.code === "pdf_missing",
  );
});

test("auto-initials: external pdfUrl -> 422 pdf_not_local with clear message", async () => {
  await assert.rejects(
    () => autoPlaceFooterInitials(envelopeWith("https://example.com/plan.pdf")),
    (err: any) =>
      err.status === 422 &&
      err.code === "pdf_not_local" &&
      /hosted externally/.test(err.message),
  );
});
