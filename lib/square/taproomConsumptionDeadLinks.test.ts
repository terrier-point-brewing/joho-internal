// lib/square/taproomConsumptionDeadLinks.test.ts
//
// A mapping pointed at a deleted Square variation cannot be found by assembling
// sales — its sales never arrive to be assembled, because the sales query only
// asks Square about the ids the mappings hold. It has to be read off the catalog
// mirror instead. These cover that path through the real IO wrapper.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./inventory", () => ({
  fetchOrderSalesByDay: vi.fn(async () => new Map()),
  fetchDraftRestockLineItems: vi.fn(async () => []),
}));

import { deriveTaproomConsumption } from "./taproomConsumption";

/**
 * Table-dispatching supabase double covering every read `deriveTaproomConsumption`
 * makes, including the two `findDeadLinks` adds. `catalogVariations` is the
 * mirror; leaving a link's variation out of it is what makes the link dead.
 */
function fakeSupabase(opts: {
  links: Record<string, unknown>[];
  catalogVariations: Record<string, unknown>[];
  /**
   * 1-based index of the `square_catalog_variations` read to fail. The table is
   * read twice per derive — first for the unmapped-sale sibling candidates, then
   * by `findDeadLinks` — and only the second is the best-effort one, so failing
   * them indiscriminately would not test what it claims to.
   */
  failCatalogReadNumber?: number;
}) {
  let catalogReads = 0;

  const result = (data: unknown[] | null, error: { message: string } | null = null) => {
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      is: () => q,
      order: () => q,
      then: (resolve: (v: { data: unknown[] | null; error: { message: string } | null }) => unknown) =>
        resolve({ data, error }),
    };
    return q;
  };

  return {
    from: (table: string) => {
      if (table === "recipe_square_links") return result(opts.links);
      if (table === "square_catalog_variations") {
        catalogReads++;
        return catalogReads === opts.failCatalogReadNumber
          ? result(null, { message: "mirror unavailable" })
          : result(opts.catalogVariations);
      }
      return result([]);
    },
  } as never;
}

const canLink = (squareVariationId: string) => ({
  id: `L-${squareVariationId}`,
  recipe_id: "7a2c2d84",
  packaging: "can",
  square_variation_id: squareVariationId,
  square_item_id: "EVYK4L3GVJN6LC3JZ6IBRRIF",
  variation_id: "6177b466",
  variation_name: "Regular - 16oz 4-Pack",
  item_name: "Epic Hazy IPA (Cans)",
  recipes: { beer_name: "Epic Hazy IPA" },
});

beforeEach(() => vi.clearAllMocks());

describe("deriveTaproomConsumption — dead Square links", () => {
  it("stays quiet when every mapping resolves to a live variation", async () => {
    const { discrepancies } = await deriveTaproomConsumption(
      fakeSupabase({
        links: [canLink("SQ-LIVE")],
        catalogVariations: [
          { square_variation_id: "SQ-LIVE", square_item_id: "EVYK4L3GVJN6LC3JZ6IBRRIF", is_deleted: false },
        ],
      }),
      { days: 14 },
    );

    expect(discrepancies.filter((d) => d.kind === "dead_square_link")).toEqual([]);
  });

  it("raises a mapping the mirror has flagged deleted", async () => {
    // The 2026-07-25 shape: the variation was deleted in Square and recreated
    // under a new id, and the mapping still points at the corpse.
    const { discrepancies } = await deriveTaproomConsumption(
      fakeSupabase({
        links: [canLink("SQ-GONE")],
        catalogVariations: [
          { square_variation_id: "SQ-GONE", square_item_id: "EVYK4L3GVJN6LC3JZ6IBRRIF", is_deleted: true },
        ],
      }),
      { days: 14 },
    );

    expect(discrepancies).toContainEqual({
      kind: "dead_square_link",
      recipeId: "7a2c2d84",
      squareVariationId: "SQ-GONE",
      packaging: "can",
      itemName: "Epic Hazy IPA (Cans)",
      variationName: "Regular - 16oz 4-Pack",
      reason: "deleted_in_square",
    });
  });

  it("distinguishes a mapping the mirror has never seen", async () => {
    // Different fix: this one is often just a mirror that has not been refreshed
    // since the mapping was made, which the nightly catalog sync now handles.
    const { discrepancies } = await deriveTaproomConsumption(
      fakeSupabase({ links: [canLink("SQ-UNKNOWN")], catalogVariations: [] }),
      { days: 14 },
    );

    expect(discrepancies).toContainEqual(
      expect.objectContaining({ kind: "dead_square_link", reason: "missing_from_catalog" }),
    );
  });

  it("still reconciles when the dead-link check cannot read the mirror", async () => {
    // The check is a report about the run. It must never take down the
    // reconciliation, which is the part that actually books beer.
    const { discrepancies } = await deriveTaproomConsumption(
      fakeSupabase({
        links: [canLink("SQ-LIVE")],
        catalogVariations: [],
        failCatalogReadNumber: 2, // the findDeadLinks read
      }),
      { days: 14 },
    );

    expect(discrepancies.filter((d) => d.kind === "dead_square_link")).toEqual([]);
  });
});
