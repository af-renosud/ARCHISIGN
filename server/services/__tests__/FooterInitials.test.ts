import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFooterInitialPlacements,
  FOOTER_INITIAL_BOX,
  FOOTER_INITIAL_MARGIN,
  FOOTER_INITIAL_GAP,
  FOOTER_INITIAL_LAST_PAGE_BASE_Y,
} from "../PdfService";

const A4 = { width: 595.28, height: 841.89 };

function bottomLeftY(p: { yPos: number; height: number }, ph: number): number {
  // Invert the normalized top-left convention back to PDF bottom-left points.
  return ph - (p.yPos + p.height) * ph;
}

test("footer initials: one box per signer per page", () => {
  const placements = computeFooterInitialPlacements([A4, A4, A4], 2);
  assert.equal(placements.length, 6);
  for (let page = 1; page <= 3; page++) {
    const onPage = placements.filter((p) => p.pageNumber === page);
    assert.equal(onPage.length, 2);
    assert.deepEqual(onPage.map((p) => p.signerIndex).sort(), [0, 1]);
  }
});

test("footer initials: zero signers or zero pages -> empty", () => {
  assert.equal(computeFooterInitialPlacements([], 3).length, 0);
  assert.equal(computeFooterInitialPlacements([A4], 0).length, 0);
});

test("footer initials: boxes laid side-by-side from bottom-left with margin and gap", () => {
  const placements = computeFooterInitialPlacements([A4, A4], 3);
  const page1 = placements.filter((p) => p.pageNumber === 1);
  const w = FOOTER_INITIAL_BOX.width;
  for (let i = 0; i < 3; i++) {
    const expectedX = FOOTER_INITIAL_MARGIN + i * (w + FOOTER_INITIAL_GAP);
    assert.ok(Math.abs(page1[i].xPos * A4.width - expectedX) < 0.01);
    assert.ok(Math.abs(bottomLeftY(page1[i], A4.height) - FOOTER_INITIAL_MARGIN) < 0.01);
  }
});

test("footer initials: last page row is lifted above the fixed signature zone", () => {
  const placements = computeFooterInitialPlacements([A4, A4], 1);
  const lastPage = placements.find((p) => p.pageNumber === 2)!;
  const y = bottomLeftY(lastPage, A4.height);
  assert.ok(Math.abs(y - FOOTER_INITIAL_LAST_PAGE_BASE_Y) < 0.01);
  // Must clear 10mm padding + 96pt signature box.
  assert.ok(y >= 10 * 2.83465 + 96);
});

test("footer initials: row wraps upward when signers exceed page width", () => {
  const narrow = { width: 200, height: 400 };
  // 200pt page, 12pt margins -> only 2 boxes of 60pt (+8 gap) fit per row.
  const placements = computeFooterInitialPlacements([narrow], 5);
  assert.equal(placements.length, 5);
  const rows = new Map<number, number>();
  for (const p of placements) {
    const y = Math.round(bottomLeftY(p, narrow.height));
    rows.set(y, (rows.get(y) || 0) + 1);
    // Every box stays inside the horizontal margins.
    const x = p.xPos * narrow.width;
    assert.ok(x >= FOOTER_INITIAL_MARGIN - 0.01);
    assert.ok(x + p.width * narrow.width <= narrow.width - FOOTER_INITIAL_MARGIN + 0.01);
  }
  assert.ok(rows.size >= 2, "expected wrapping onto multiple rows");
  for (const count of rows.values()) assert.ok(count <= 2);
});

test("footer initials: normalized coordinates stay within [0,1]", () => {
  const placements = computeFooterInitialPlacements([A4, { width: 841.89, height: 595.28 }], 4);
  for (const p of placements) {
    assert.ok(p.xPos >= 0 && p.xPos <= 1);
    assert.ok(p.yPos >= 0 && p.yPos <= 1);
    assert.ok(p.width > 0 && p.width <= 1);
    assert.ok(p.height > 0 && p.height <= 1);
  }
});
