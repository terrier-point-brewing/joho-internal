import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/square/inventory", () => ({ fetchOrderSalesByDay: vi.fn() }));

import { sumPourFlOz, fetchPourFlOzBetweenWith } from "./kegPourWindow";
import { fetchOrderSalesByDay } from "@/lib/square/inventory";

const pourSales = vi.mocked(fetchOrderSalesByDay);

describe("sumPourFlOz", () => {
  const vars = [{ id: "v5", oz: 5 }, { id: "v16", oz: 16 }];

  it("multiplies each pour size by its units", () => {
    const out = sumPourFlOz(new Map([["v5\t2026-07-01", 4], ["v16\t2026-07-01", 10]]), vars);
    expect(out).toEqual({ flOz: 180, unmappedVariationIds: [] });
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

describe("fetchPourFlOzBetweenWith", () => {
  it("queries Square with the window bounds verbatim and only this recipe's pours", async () => {
    pourSales.mockResolvedValue(new Map([["v16\t2026-07-02", 3]]));
    const out = await fetchPourFlOzBetweenWith(
      new Map([["r1", [{ id: "v16", oz: 16 }]]]),
      "r1", "2026-07-01T10:00:00Z", "2026-07-04T20:00:00Z",
    );
    expect(pourSales).toHaveBeenCalledWith("2026-07-01T10:00:00Z", "2026-07-04T20:00:00Z", ["v16"]);
    expect(out).toEqual({ flOz: 48, unmappedVariationIds: [] });
  });

  it("returns null when the recipe has no pour variations to measure", async () => {
    const out = await fetchPourFlOzBetweenWith(new Map(), "r1", "2026-07-01T10:00:00Z", "2026-07-04T20:00:00Z");
    expect(out).toBeNull();
  });
});
