// Pure-logic tests for resolveSnapshotWrites -- the decision function that
// snapshotPeriod's IO wrapper delegates to. See snapshot.ts's header comment
// for the contract: sum every active provider's non-null result per account,
// record each contribution by provider key, write NO row when every
// provider is null, and never touch a frozen row.
import { describe, it, expect } from "vitest";
import { resolveSnapshotWrites } from "./snapshot";

describe("resolveSnapshotWrites", () => {
  it("skips a frozen existing row entirely, even with fresh provider results", () => {
    const sources = [{ coaId: "coa-1", providerKey: "manualBalance" }];
    const results = new Map<string, number | null>([["coa-1:manualBalance", 500]]);
    const existing = new Map([["coa-1", { isFrozen: true }]]);

    const writes = resolveSnapshotWrites(sources, results, existing);

    expect(writes).toEqual([]);
  });

  it("sums two providers on one account and records both contributions", () => {
    const sources = [
      { coaId: "coa-2220", providerKey: "taxAccrual" },
      { coaId: "coa-2220", providerKey: "transactionPostings" },
    ];
    const results = new Map<string, number | null>([
      ["coa-2220:taxAccrual", -1000],
      ["coa-2220:transactionPostings", -200],
    ]);
    const existing = new Map<string, { isFrozen: boolean }>();

    const writes = resolveSnapshotWrites(sources, results, existing);

    expect(writes).toEqual([
      {
        coaId: "coa-2220",
        balanceCents: -1200,
        contributions: { taxAccrual: -1000, transactionPostings: -200 },
      },
    ]);
  });

  it("writes the other provider's value when one provider returns null, recording only the non-null contribution", () => {
    const sources = [
      { coaId: "coa-2220", providerKey: "taxAccrual" },
      { coaId: "coa-2220", providerKey: "transactionPostings" },
    ];
    const results = new Map<string, number | null>([
      ["coa-2220:taxAccrual", null],
      ["coa-2220:transactionPostings", -200],
    ]);
    const existing = new Map<string, { isFrozen: boolean }>();

    const writes = resolveSnapshotWrites(sources, results, existing);

    expect(writes).toEqual([
      { coaId: "coa-2220", balanceCents: -200, contributions: { transactionPostings: -200 } },
    ]);
  });

  it("writes no row at all when every provider is null -- the account must read as unsourced, not a spurious $0", () => {
    const sources = [
      { coaId: "coa-2220", providerKey: "taxAccrual" },
      { coaId: "coa-2220", providerKey: "transactionPostings" },
    ];
    const results = new Map<string, number | null>([
      ["coa-2220:taxAccrual", null],
      ["coa-2220:transactionPostings", null],
    ]);
    const existing = new Map<string, { isFrozen: boolean }>();

    const writes = resolveSnapshotWrites(sources, results, existing);

    expect(writes).toEqual([]);
  });

  it("updates an existing non-frozen row in place, unlike autoMap.ts's fill-nulls-only convention", () => {
    const sources = [{ coaId: "coa-1", providerKey: "manualBalance" }];
    const results = new Map<string, number | null>([["coa-1:manualBalance", 750]]);
    const existing = new Map([["coa-1", { isFrozen: false }]]);

    const writes = resolveSnapshotWrites(sources, results, existing);

    expect(writes).toEqual([
      { coaId: "coa-1", balanceCents: 750, contributions: { manualBalance: 750 } },
    ]);
  });

  it("skips a source naming an unregistered provider key without throwing", () => {
    // A registry miss never gets an entry in `results` (snapshotPeriod skips
    // calling compute() for it and reports the miss in its own errors list) --
    // resolveSnapshotWrites just sees an absent key and must not crash.
    const sources = [{ coaId: "coa-1", providerKey: "notARealProvider" }];
    const results = new Map<string, number | null>();
    const existing = new Map<string, { isFrozen: boolean }>();

    expect(() => resolveSnapshotWrites(sources, results, existing)).not.toThrow();
    expect(resolveSnapshotWrites(sources, results, existing)).toEqual([]);
  });
});
