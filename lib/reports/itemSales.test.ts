import { describe, it, expect } from "vitest";
import { buildItemSalesData, itemKey, itemGroupKey, matchesItemKey } from "./itemSales";
import type { TaproomLineContribution } from "@/types/reports";

const TZ = "America/New_York";

function line(over: Partial<TaproomLineContribution>): TaproomLineContribution {
  return {
    categoryId: "NA_SNACKS", orderId: "o", lineUid: "u", occurredAt: "2026-10-06T18:00:00Z",
    itemName: "Kettle Chips", variationName: "BBQ", quantity: 1,
    grossSalesCents: 500, discountsCents: 0, returnsCents: 0, taxCents: 0,
    discountNames: [], kind: "sale", prorated: false, ...over,
  };
}

describe("buildItemSalesData", () => {
  it("keys items on item + variation and buckets events by brewery-local day", () => {
    const d = buildItemSalesData([
      line({ quantity: 2, grossSalesCents: 1000 }),
      line({ variationName: "Salt & Vinegar" }),
      // 11:30pm Oct 6 in New York — still Oct 6, though UTC says Oct 7.
      line({ occurredAt: "2026-10-07T03:30:00Z", quantity: 3, grossSalesCents: 1500 }),
      line({ occurredAt: "2026-10-08T18:00:00Z" }),
    ], "2026-10-01", "2026-10-10", TZ);

    expect(d.items.map((i) => i.variationName)).toEqual(["BBQ", "Salt & Vinegar"]);
    const bbq = itemKey(line({}));
    expect(d.events.filter((e) => e.item_id === bbq)).toEqual([
      { item_id: bbq, date: "2026-10-06", units: 5, net_cents: 2500, fl_oz: 0 },
      { item_id: bbq, date: "2026-10-08", units: 1, net_cents: 500, fl_oz: 0 },
    ]);
  });

  it("carries fl oz per unit when the resolver knows it", () => {
    const d = buildItemSalesData(
      [line({ itemName: "Oktoberfest", variationName: "Draft - 16oz", quantity: 2 }),
       line({ itemName: "Oktoberfest", variationName: "Draft - 5oz", quantity: 1 })],
      "2026-10-01", "2026-10-10", TZ,
      (_i, v) => (v.includes("16oz") ? 16 : v.includes("5oz") ? 5 : null),
    );
    expect(d.items.map((i) => i.flOzPerUnit)).toEqual([16, 5]);
    expect(d.events.map((e) => e.fl_oz).sort()).toEqual([32, 5]);
  });

  it("matches a line to its exact key or to its item group", () => {
    const l = line({});
    expect(matchesItemKey(l, itemKey(l))).toBe(true);
    expect(matchesItemKey(l, itemGroupKey(l))).toBe(true);
    expect(matchesItemKey(l, itemKey(line({ variationName: "Sea Salt" })))).toBe(false);
    expect(matchesItemKey(l, itemGroupKey(line({ itemName: "Pretzel" })))).toBe(false);
  });

  it("nets discounts and returns, and a return takes units back", () => {
    const d = buildItemSalesData([
      line({ quantity: 2, grossSalesCents: 1000, discountsCents: 100 }),
      line({ kind: "return", quantity: 1, grossSalesCents: 0, returnsCents: 500 }),
    ], "2026-10-01", "2026-10-10", TZ);
    expect(d.events).toEqual([{ item_id: itemKey(line({})), date: "2026-10-06", units: 1, net_cents: 400, fl_oz: 0 }]);
  });
});
