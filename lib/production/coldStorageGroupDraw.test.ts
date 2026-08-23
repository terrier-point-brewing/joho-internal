import { describe, it, expect } from "vitest";
import { planGroupDraw, orderGroupByAge, summariseFamilyAges, type DrawLot } from "./coldStorageGroupDraw";

const lot = (variationId: string, quantityOnHand: number, createdAt: string): DrawLot => ({
  variationId,
  quantityOnHand,
  createdAt,
});

describe("planGroupDraw", () => {
  it("takes the oldest lot first, whichever packaging it belongs to", () => {
    const { slices, shortfall } = planGroupDraw(
      [lot("printed", 10, "2026-08-01T00:00:00Z"), lot("labeled", 20, "2026-08-21T00:00:00Z")],
      4,
    );
    expect(slices).toEqual([{ variationId: "printed", quantity: 4 }]);
    expect(shortfall).toBe(0);
  });

  it("moves on to the next packaging once the older one runs out", () => {
    const { slices, shortfall } = planGroupDraw(
      [lot("printed", 10, "2026-08-01T00:00:00Z"), lot("labeled", 20, "2026-08-21T00:00:00Z")],
      14,
    );
    expect(slices).toEqual([
      { variationId: "printed", quantity: 10 },
      { variationId: "labeled", quantity: 4 },
    ]);
    expect(shortfall).toBe(0);
  });

  it("is driven by lot age, not by the order the rows arrived in", () => {
    const older = lot("labeled", 5, "2026-07-01T00:00:00Z");
    const newer = lot("printed", 5, "2026-08-01T00:00:00Z");
    expect(planGroupDraw([newer, older], 3).slices).toEqual([{ variationId: "labeled", quantity: 3 }]);
    expect(planGroupDraw([older, newer], 3).slices).toEqual([{ variationId: "labeled", quantity: 3 }]);
  });

  // One sale should not become three export rows because the lots happen to
  // interleave by age. The beer taken is the same either way; the row count is
  // what the customer's ledger has to live with.
  it("collapses interleaved lots of one packaging into a single slice", () => {
    const { slices } = planGroupDraw(
      [
        lot("printed", 2, "2026-08-01T00:00:00Z"),
        lot("labeled", 2, "2026-08-02T00:00:00Z"),
        lot("printed", 2, "2026-08-03T00:00:00Z"),
      ],
      6,
    );
    expect(slices).toEqual([
      { variationId: "printed", quantity: 4 },
      { variationId: "labeled", quantity: 2 },
    ]);
  });

  it("reports what the whole group could not cover rather than over-drawing", () => {
    const { slices, shortfall } = planGroupDraw(
      [lot("printed", 3, "2026-08-01T00:00:00Z"), lot("labeled", 2, "2026-08-02T00:00:00Z")],
      9,
    );
    expect(slices).toEqual([
      { variationId: "printed", quantity: 3 },
      { variationId: "labeled", quantity: 2 },
    ]);
    expect(shortfall).toBe(4);
  });

  it("skips emptied lots instead of counting them as available", () => {
    const { slices } = planGroupDraw(
      [lot("printed", 0, "2026-08-01T00:00:00Z"), lot("labeled", 5, "2026-08-02T00:00:00Z")],
      2,
    );
    expect(slices).toEqual([{ variationId: "labeled", quantity: 2 }]);
  });

  // Summing several fractional lots leaves float dust, and a slice fractionally
  // larger than what is on hand is a slice depletion cannot cover.
  it("clears float dust off a slice summed from fractional lots", () => {
    const { slices } = planGroupDraw(
      [lot("printed", 0.1, "2026-08-01T00:00:00Z"), lot("printed", 0.2, "2026-08-02T00:00:00Z")],
      0.3,
    );
    expect(slices).toEqual([{ variationId: "printed", quantity: 0.3 }]);
  });

  it("draws nothing when the group is empty", () => {
    expect(planGroupDraw([], 5)).toEqual({ slices: [], shortfall: 5 });
  });
});

describe("orderGroupByAge", () => {
  it("tries the packaging with the oldest stock first", () => {
    const lots = [lot("labeled", 5, "2026-08-21T00:00:00Z"), lot("printed", 5, "2026-08-01T00:00:00Z")];
    expect(orderGroupByAge(lots, ["labeled", "printed"])).toEqual(["printed", "labeled"]);
  });

  // A member with nothing on hand still gets a turn: the tier being cracked open
  // lives in a different variation of its family, and may well be sitting there.
  it("keeps an empty member as a candidate, but last", () => {
    const lots = [lot("printed", 5, "2026-08-01T00:00:00Z")];
    expect(orderGroupByAge(lots, ["labeled", "printed"])).toEqual(["printed", "labeled"]);
  });

  it("is stable when two members have nothing to sort on", () => {
    expect(orderGroupByAge([], ["b", "a"])).toEqual(["a", "b"]);
  });
});

// The ranking pass 2 actually uses. It runs only AFTER pass 1 has emptied every
// member's own tier, so the age that decides which member to crack open lives in
// a higher tier — a case or a pack — of that member's identity family. Ranking on
// the member tier alone leaves everyone ageless and silently falls through to the
// id tiebreak, which is how a case packaged this week gets opened while one from
// May sits behind it.
describe("summariseFamilyAges", () => {
  const families = new Map([
    ["printed-loose", ["printed-loose", "printed-4pack", "printed-case"]],
    ["labeled-loose", ["labeled-loose", "labeled-4pack", "labeled-case"]],
  ]);

  it("ages a member by the oldest stock anywhere in its family, not just its own tier", () => {
    const summary = summariseFamilyAges(families, [
      lot("printed-case", 2, "2026-05-01T00:00:00Z"),
      lot("labeled-case", 2, "2026-08-20T00:00:00Z"),
    ]);
    expect(orderGroupByAge(summary, ["labeled-loose", "printed-loose"])).toEqual([
      "printed-loose",
      "labeled-loose",
    ]);
  });

  it("totals the family's stock across every tier", () => {
    const summary = summariseFamilyAges(families, [
      lot("printed-4pack", 3, "2026-06-01T00:00:00Z"),
      lot("printed-case", 2, "2026-05-01T00:00:00Z"),
    ]);
    expect(summary).toEqual([
      { variationId: "printed-loose", quantityOnHand: 5, createdAt: "2026-05-01T00:00:00Z" },
    ]);
  });

  // depleteColdStorageInventory deletes rows at ~0, but a zeroed row that has not
  // been swept must not lend its date to a member that has nothing to crack.
  it("ignores emptied lots when dating a family", () => {
    const summary = summariseFamilyAges(families, [
      lot("printed-case", 0, "2026-05-01T00:00:00Z"),
      lot("labeled-case", 1, "2026-08-20T00:00:00Z"),
    ]);
    expect(summary.map((s) => s.variationId)).toEqual(["labeled-loose"]);
    // printed has nothing anywhere, so it is still tried — just last.
    expect(orderGroupByAge(summary, ["printed-loose", "labeled-loose"])).toEqual([
      "labeled-loose",
      "printed-loose",
    ]);
  });

  it("omits a member whose whole family is empty", () => {
    expect(summariseFamilyAges(families, [])).toEqual([]);
  });
});
