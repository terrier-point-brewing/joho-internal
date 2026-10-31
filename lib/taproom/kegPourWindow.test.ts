import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/square/inventory", () => ({ fetchOrderLineEvents: vi.fn() }));

import { sumPourFlOz, sumPourEvents, inferMissedRings, fetchPourFlOzBetweenWith } from "./kegPourWindow";
import { fetchOrderLineEvents } from "@/lib/square/inventory";

const pourLines = vi.mocked(fetchOrderLineEvents);

describe("sumPourFlOz", () => {
  const vars = [{ id: "v5", oz: 5 }, { id: "v16", oz: 16 }];

  it("multiplies each pour size by its units", () => {
    const out = sumPourFlOz(new Map([["v5\t2026-07-01", 4], ["v16\t2026-07-01", 10]]), vars);
    expect(out).toEqual({ flOz: 180, events: [], unmappedVariationIds: [] });
  });

  it("sums across days — the request already bounded the window", () => {
    const out = sumPourFlOz(new Map([["v16\t2026-07-01", 2], ["v16\t2026-07-02", 3]]), vars);
    expect(out.flOz).toBe(80);
  });

  it("ignores variations that aren't this recipe's pour sizes", () => {
    const out = sumPourFlOz(new Map([["v16\t2026-07-01", 1], ["someone-else\t2026-07-01", 99]]), vars);
    expect(out.flOz).toBe(16);
  });

  it("reports a pour size with no fl oz mapping rather than silently dropping it", () => {
    // Silently skipping it would report the volume it sold as missing beer.
    const out = sumPourFlOz(
      new Map([["v16\t2026-07-01", 1], ["v-new\t2026-07-01", 8]]),
      [...vars, { id: "v-new", oz: null }],
    );
    expect(out.flOz).toBe(16);
    expect(out.unmappedVariationIds).toEqual(["v-new"]);
  });

  it("does not flag an unmapped size that sold nothing", () => {
    const out = sumPourFlOz(new Map([["v16\t2026-07-01", 1]]), [...vars, { id: "v-new", oz: null }]);
    expect(out.unmappedVariationIds).toEqual([]);
  });
});

describe("sumPourEvents", () => {
  const vars = [{ id: "v5", oz: 5 }, { id: "v16", oz: 16 }];

  it("keeps each pour as an event in the order given, with its fl oz", () => {
    const out = sumPourEvents([
      { at: "2026-07-01T18:00:00Z", variationId: "v16", units: 2 },
      { at: "2026-07-01T19:00:00Z", variationId: "v5", units: 1 },
      { at: "2026-07-01T19:30:00Z", variationId: "someone-else", units: 9 },
    ], vars);
    expect(out.flOz).toBe(37);
    expect(out.events).toEqual([
      { at: "2026-07-01T18:00:00Z", flOz: 32 },
      { at: "2026-07-01T19:00:00Z", flOz: 5 },
    ]);
    expect(out.unmappedVariationIds).toEqual([]);
  });

  it("reports an unmapped size that sold, and leaves it out of the events", () => {
    const out = sumPourEvents(
      [{ at: "2026-07-01T18:00:00Z", variationId: "v-new", units: 3 }],
      [...vars, { id: "v-new", oz: null }],
    );
    expect(out).toEqual({ flOz: 0, events: [], unmappedVariationIds: ["v-new"] });
  });
});

describe("inferMissedRings", () => {
  const pour = (at: string, flOz: number) => ({ at, flOz });

  it("finds nothing when the pours fit in one keg", () => {
    expect(inferMissedRings([pour("t1", 300), pour("t2", 300)], 661)).toEqual([]);
  });

  it("finds nothing at exactly one keg — that keg blew at this ring, not before it", () => {
    expect(inferMissedRings([pour("t1", 661)], 661)).toEqual([]);
  });

  it("reads up to four pints past the keg as a late ring, and one more as a missed keg", () => {
    expect(inferMissedRings([pour("t1", 661), pour("t2", 64)], 661)).toEqual([]);
    expect(inferMissedRings([pour("t1", 661), pour("t2", 65)], 661)).toEqual([{ occurredAt: "t2", kegIndex: 1 }]);
  });

  it("takes a tolerance of its own", () => {
    expect(inferMissedRings([pour("t1", 700)], 661, 0)).toEqual([{ occurredAt: "t1", kegIndex: 1 }]);
  });

  it("places each missed ring at the pour that pushed the total past a whole keg", () => {
    // 1,635 fl oz through a 661 fl oz sixtel: the total passed 661 (plus the
    // late-ring tolerance) at t4 and 1,322 at t5, so two kegs went on with no
    // ring. The keg coming off at the real ring has poured the remaining 313.
    const out = inferMissedRings([
      pour("t1", 400), pour("t2", 200), pour("t3", 100), pour("t4", 500), pour("t5", 200), pour("t6", 235),
    ], 661);
    expect(out).toEqual([
      { occurredAt: "t4", kegIndex: 1 },
      { occurredAt: "t5", kegIndex: 2 },
    ]);
  });

  it("one pour that spans several kegs yields one missed ring per keg at that pour", () => {
    expect(inferMissedRings([pour("t1", 2100)], 661)).toEqual([
      { occurredAt: "t1", kegIndex: 1 },
      { occurredAt: "t1", kegIndex: 2 },
      { occurredAt: "t1", kegIndex: 3 },
    ]);
  });

  it("measures nothing against a keg of no size", () => {
    expect(inferMissedRings([pour("t1", 2000)], 0)).toEqual([]);
  });
});

describe("fetchPourFlOzBetweenWith", () => {
  it("queries Square with the window bounds verbatim and only this recipe's pours", async () => {
    pourLines.mockResolvedValue([{ at: "2026-07-02T18:00:00Z", variationId: "v16", units: 3 }]);
    const out = await fetchPourFlOzBetweenWith(
      new Map([["r1", [{ id: "v16", oz: 16 }]]]),
      "r1", "2026-07-01T10:00:00Z", "2026-07-04T20:00:00Z",
    );
    expect(pourLines).toHaveBeenCalledWith("2026-07-01T10:00:00Z", "2026-07-04T20:00:00Z", ["v16"]);
    expect(out).toEqual({ flOz: 48, events: [{ at: "2026-07-02T18:00:00Z", flOz: 48 }], unmappedVariationIds: [] });
  });

  it("returns null when the recipe has no pour variations to measure", async () => {
    const out = await fetchPourFlOzBetweenWith(new Map(), "r1", "2026-07-01T10:00:00Z", "2026-07-04T20:00:00Z");
    expect(out).toBeNull();
  });
});
