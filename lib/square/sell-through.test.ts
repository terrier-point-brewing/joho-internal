import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/square/inventory", () => ({
  fetchCurrentCounts: vi.fn(),
  fetchOrderSales: vi.fn(),
}));
vi.mock("@/lib/taproom/draftPourConsumption", () => ({
  fetchDailyPourSellThrough: vi.fn(),
}));

import { fetchSellThrough } from "./sell-through";
import { fetchCurrentCounts, fetchOrderSales } from "@/lib/square/inventory";
import { fetchDailyPourSellThrough } from "@/lib/taproom/draftPourConsumption";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

const currentCounts = vi.mocked(fetchCurrentCounts);
const orderSales = vi.mocked(fetchOrderSales);
const pourSellThrough = vi.mocked(fetchDailyPourSellThrough);

beforeEach(() => {
  currentCounts.mockReset();
  orderSales.mockReset();
  pourSellThrough.mockReset();
  // Sensible defaults so tests only need to override what they care about.
  currentCounts.mockResolvedValue(new Map());
  orderSales.mockResolvedValue(new Map());
  pourSellThrough.mockResolvedValue(new Map());
});

interface LinkRow {
  id: string;
  packaging: "draft" | "keg" | "can";
  packaging_item_id: string | null;
  square_variation_id: string;
  square_item_id: string | null;
  variation_name: string | null;
  item_name: string | null;
  recipe_id: string;
  recipes: { beer_name: string; days_brewhouse: number | null; days_fermenter: number | null; days_brite: number | null } | null;
  packaging_items: { id: string; name: string; type: string; volume_fl_oz: number | null } | null;
}

function draftLink(over: Partial<LinkRow> = {}): LinkRow {
  return {
    id: "link-draft-1",
    packaging: "draft",
    packaging_item_id: null,
    square_variation_id: "V-DRAFT-1",
    square_item_id: "ITEM-DRAFT-1",
    variation_name: "Draft",
    item_name: "Hazy IPA",
    recipe_id: "r1",
    recipes: { beer_name: "Hazy IPA", days_brewhouse: null, days_fermenter: null, days_brite: null },
    packaging_items: null,
    ...over,
  };
}

function kegLink(over: Partial<LinkRow> = {}): LinkRow {
  return {
    id: "link-keg-1",
    packaging: "keg",
    packaging_item_id: "PI-KEG",
    square_variation_id: "V-KEG-1",
    square_item_id: "ITEM-KEG-1",
    variation_name: "1/2 BBL Keg",
    item_name: "Hazy IPA",
    recipe_id: "r1",
    recipes: { beer_name: "Hazy IPA", days_brewhouse: null, days_fermenter: null, days_brite: null },
    packaging_items: { id: "PI-KEG", name: "1/2 BBL Keg", type: "keg", volume_fl_oz: 1984 },
    ...over,
  };
}

function canLink(over: Partial<LinkRow> = {}): LinkRow {
  return {
    id: "link-can-1",
    packaging: "can",
    packaging_item_id: "PI-CAN",
    square_variation_id: "V-CAN-1",
    square_item_id: "ITEM-CAN-1",
    variation_name: "16oz Can",
    item_name: "Hazy IPA",
    recipe_id: "r1",
    recipes: { beer_name: "Hazy IPA", days_brewhouse: null, days_fermenter: null, days_brite: null },
    packaging_items: { id: "PI-CAN", name: "16oz Can", type: "can", volume_fl_oz: 16 },
    ...over,
  };
}

function fakeSupabase(opts: {
  links: LinkRow[];
  catalogVariations?: { square_variation_id: string; volume_fl_oz_per_unit: number | null }[];
}) {
  return {
    from: (table: string) => {
      if (table === "recipe_square_links") {
        return {
          select: () => ({
            data: opts.links,
            error: null,
            eq: (_col: string, val: string) => ({
              data: opts.links.filter((l) => l.packaging === val),
              error: null,
            }),
          }),
        };
      }
      if (table === "square_catalog_variations") {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) => ({
              data: (opts.catalogVariations ?? []).filter((v) => ids.includes(v.square_variation_id)),
              error: null,
            }),
          }),
        };
      }
      throw new Error(`fakeSupabase: unexpected table ${table}`);
    },
  } as never;
}

describe("fetchSellThrough — draft branch reads the pour ledger", () => {
  it("derives daily_sell_through_bbl/units from fetchDailyPourSellThrough, not order sales", async () => {
    const supabase = fakeSupabase({ links: [draftLink({ recipe_id: "r1" })] });
    currentCounts.mockResolvedValue(new Map([["V-DRAFT-1", 640]])); // fl oz remaining in keg
    pourSellThrough.mockResolvedValue(new Map([["r1", { dailyFlOz: 100, dailyUnits: 8 }]]));
    // If the draft branch were still summing order sales, this large number would leak through.
    orderSales.mockResolvedValue(new Map([["V-DRAFT-1", 99999]]));

    const [result] = await fetchSellThrough(supabase, { packaging: "draft" });

    expect(pourSellThrough).toHaveBeenCalledWith(supabase, 30);
    expect(result.daily_sell_through_units).toBe(8);
    expect(result.daily_sell_through_bbl).toBe(Number((100 / BBL_TO_FL_OZ).toFixed(4)));
  });

  it("still sources current_qty/current_bbl from fetchCurrentCounts (Square live)", async () => {
    const supabase = fakeSupabase({ links: [draftLink({ recipe_id: "r1", square_variation_id: "V-DRAFT-1" })] });
    currentCounts.mockResolvedValue(new Map([["V-DRAFT-1", 640]]));
    pourSellThrough.mockResolvedValue(new Map());

    const [result] = await fetchSellThrough(supabase, { packaging: "draft" });

    expect(currentCounts).toHaveBeenCalledWith(["V-DRAFT-1"]);
    expect(result.current_qty).toBe(640);
    expect(result.current_bbl).toBe(Number((640 / BBL_TO_FL_OZ).toFixed(4)));
  });

  it("returns zeroed daily metrics for a recipe missing from the ledger", async () => {
    const supabase = fakeSupabase({ links: [draftLink({ recipe_id: "r-no-ledger" })] });
    currentCounts.mockResolvedValue(new Map([["V-DRAFT-1", 0]]));
    pourSellThrough.mockResolvedValue(new Map()); // no entry for r-no-ledger

    const [result] = await fetchSellThrough(supabase, { packaging: "draft" });

    expect(result.daily_sell_through_units).toBe(0);
    expect(result.daily_sell_through_bbl).toBe(0);
  });
});

describe("fetchSellThrough — keg/can branches are unchanged", () => {
  it("keg: computes daily sell-through from fetchOrderSales (behavior preserved)", async () => {
    const supabase = fakeSupabase({ links: [kegLink()] });
    currentCounts.mockResolvedValue(new Map([["V-KEG-1", 2]]));
    orderSales.mockResolvedValue(new Map([["V-KEG-1", 30]])); // 30 sold over 30-day window

    const [result] = await fetchSellThrough(supabase, { packaging: "keg" });

    expect(orderSales).toHaveBeenCalled();
    expect(result.daily_sell_through_units).toBe(1); // 30 / 30 days
    expect(result.daily_sell_through_bbl).toBe(Number(((1 * 1984) / BBL_TO_FL_OZ).toFixed(4)));
    expect(result.current_qty).toBe(2);
    // Draft ledger read must not be triggered for a keg-only query.
    expect(pourSellThrough).not.toHaveBeenCalled();
  });

  it("can: computes daily sell-through from fetchOrderSales using the catalog mirror's per-unit volume", async () => {
    const supabase = fakeSupabase({
      links: [canLink()],
      catalogVariations: [{ square_variation_id: "V-CAN-1", volume_fl_oz_per_unit: 16 }],
    });
    currentCounts.mockResolvedValue(new Map([["V-CAN-1", 48]]));
    orderSales.mockResolvedValue(new Map([["V-CAN-1", 60]])); // 60 sold over 30-day window

    const [result] = await fetchSellThrough(supabase, { packaging: "can" });

    expect(result.daily_sell_through_units).toBe(2); // 60 / 30 days
    expect(result.daily_sell_through_bbl).toBe(Number(((2 * 16) / BBL_TO_FL_OZ).toFixed(4)));
    expect(result.current_qty).toBe(48);
    expect(pourSellThrough).not.toHaveBeenCalled();
  });
});
