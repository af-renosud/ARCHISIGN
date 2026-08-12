import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSafeLookup } from "../ssrfGuard";

type LookupResult = {
  err: NodeJS.ErrnoException | null;
  address: string | Array<{ address: string; family: number }>;
  family?: number;
};

function runLookup(
  lookup: ReturnType<typeof makeSafeLookup>,
  hostname: string,
  opts: unknown,
): Promise<LookupResult> {
  return new Promise((resolve) => {
    lookup(hostname, opts, (err, address, family) => resolve({ err, address, family }));
  });
}

const resolver = (v4: string[], v6: string[] = []) => ({
  resolve4: async () => v4,
  resolve6: async () => v6,
});

describe("makeSafeLookup", () => {
  it("legacy shape: returns a single address string and family", async () => {
    const lookup = makeSafeLookup("pdfFetchUrl", resolver(["93.184.216.34"], ["2606:2800::1"]));
    const r = await runLookup(lookup, "example.com", {});
    assert.equal(r.err, null);
    assert.equal(r.address, "93.184.216.34");
    assert.equal(r.family, 4);
  });

  it("all:true shape (autoSelectFamily): returns array of {address, family} objects", async () => {
    const lookup = makeSafeLookup("pdfFetchUrl", resolver(["93.184.216.34"], ["2606:2800::1"]));
    const r = await runLookup(lookup, "example.com", { all: true });
    assert.equal(r.err, null);
    assert.deepEqual(r.address, [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800::1", family: 6 },
    ]);
  });

  it("all:true: rejects when any resolved address is private", async () => {
    const lookup = makeSafeLookup("pdfFetchUrl", resolver(["93.184.216.34", "10.0.0.5"]));
    const r = await runLookup(lookup, "rebind.example", { all: true });
    assert.ok(r.err);
    assert.match(r.err!.message, /private\/internal/);
    assert.equal((r.err as any).httpStatus, 400);
    assert.deepEqual(r.address, []);
  });

  it("legacy shape: rejects private addresses too", async () => {
    const lookup = makeSafeLookup("pdfFetchUrl", resolver(["192.168.1.10"]));
    const r = await runLookup(lookup, "internal.example", {});
    assert.ok(r.err);
    assert.match(r.err!.message, /private\/internal/);
  });

  it("all:true: unresolvable host fails with ENOTFOUND and empty array", async () => {
    const lookup = makeSafeLookup("pdfFetchUrl", resolver([], []));
    const r = await runLookup(lookup, "nope.invalid", { all: true });
    assert.equal((r.err as any)?.code, "ENOTFOUND");
    assert.deepEqual(r.address, []);
  });

  it("ipv6-only host works in both shapes", async () => {
    const lookup = makeSafeLookup("pdfFetchUrl", resolver([], ["2606:2800::1"]));
    const legacy = await runLookup(lookup, "v6.example", {});
    assert.equal(legacy.address, "2606:2800::1");
    assert.equal(legacy.family, 6);
    const all = await runLookup(lookup, "v6.example", { all: true });
    assert.deepEqual(all.address, [{ address: "2606:2800::1", family: 6 }]);
  });
});
