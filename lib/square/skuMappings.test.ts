import { describe, it, expect } from "vitest";
import { selectServiceMapping, resolveProductSku, type ServiceMappingRow, type SkuDbClient } from "./skuMappings";

interface RslRow {
  variation_id: string | null;
  recipe_id: string | null;
  packaging: string | null;
  square_variation_id: string;
  square_item_id: string | null;
  catalog_variation_id: string | null;
  item_name: string | null;
  variation_name: string | null;
}

// Minimal in-memory PostgREST-style client that mirrors `.maybeSingle()`'s
// contract: zero rows → { data: null }, exactly one → the row, two or more →
// the PGRST116 "multiple (or no) rows returned" error.
function fakeRslDb(rows: RslRow[]): SkuDbClient {
  return {
    from() {
      const filters: [string, unknown][] = [];
      const builder = {
        select() { return builder; },
        eq(col: string, val: unknown) { filters.push([col, val]); return builder; },
        async maybeSingle() {
          const matched = rows.filter((r) =>
            filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v)
          );
          if (matched.length > 1) {
            return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
          }
          return { data: matched[0] ?? null, error: null };
        },
      };
      return builder;
    },
  } as unknown as SkuDbClient;
}

function rslRow(p: Partial<RslRow>): RslRow {
  return {
    variation_id: null,
    recipe_id: null,
    packaging: "keg",
    square_variation_id: "SQ_DEFAULT",
    square_item_id: null,
    catalog_variation_id: null,
    item_name: null,
    variation_name: null,
    ...p,
  };
}

describe("resolveProductSku (packaged)", () => {
  // A generic keg size (e.g. "1/2 Keg") is one shared packaging_variation linked
  // by many recipes, each with its own Square SKU. Filtering on variation_id
  // alone matches every recipe's link → `.maybeSingle()` throws. The resolve
  // must disambiguate by (variation_id, recipe_id).
  const sharedKegVariation = "var-half-keg";
  const rows = [
    rslRow({ variation_id: sharedKegVariation, recipe_id: "recipe-a", square_variation_id: "SQ_A" }),
    rslRow({ variation_id: sharedKegVariation, recipe_id: "recipe-b", square_variation_id: "SQ_B" }),
  ];

  it("resolves the correct recipe's SKU for a variation shared across recipes", async () => {
    const sku = await resolveProductSku(fakeRslDb(rows), {
      kind: "packaged",
      variationId: sharedKegVariation,
      recipeId: "recipe-b",
    });
    expect(sku?.squareVariationId).toBe("SQ_B");
  });

  it("returns null when no link matches the (variation, recipe) pair", async () => {
    const sku = await resolveProductSku(fakeRslDb(rows), {
      kind: "packaged",
      variationId: sharedKegVariation,
      recipeId: "recipe-z",
    });
    expect(sku).toBeNull();
  });
});

function row(p: Partial<ServiceMappingRow>): ServiceMappingRow {
  return {
    service_type: "packaging_fee",
    partner_id: null,
    packaging_item_id: null,
    packaging_format: null,
    square_catalog_item_id: null,
    square_catalog_variation_id: null,
    square_catalog_discount_id: null,
    display_name: null,
    ...p,
  };
}

describe("selectServiceMapping", () => {
  const rows = [
    row({ service_type: "packaging_fee", partner_id: null, packaging_item_id: "c1", packaging_format: "case", display_name: "default-case" }),
    row({ service_type: "packaging_fee", partner_id: "p1", packaging_item_id: "c1", packaging_format: "case", display_name: "partner-case" }),
    row({ service_type: "keg_cleaning", partner_id: null, display_name: "kegclean" }),
  ];

  it("prefers the partner-specific row over the default", () => {
    const m = selectServiceMapping(rows, { serviceType: "packaging_fee", partnerId: "p1", packagingItemId: "c1", packagingFormat: "case" });
    expect(m?.display_name).toBe("partner-case");
  });

  it("falls back to the partner_id-null default", () => {
    const m = selectServiceMapping(rows, { serviceType: "packaging_fee", partnerId: "p2", packagingItemId: "c1", packagingFormat: "case" });
    expect(m?.display_name).toBe("default-case");
  });

  it("matches container-less services", () => {
    const m = selectServiceMapping(rows, { serviceType: "keg_cleaning", partnerId: "p1", packagingItemId: null, packagingFormat: null });
    expect(m?.display_name).toBe("kegclean");
  });

  it("returns null when nothing matches", () => {
    const m = selectServiceMapping(rows, { serviceType: "forklift", partnerId: null, packagingItemId: null, packagingFormat: null });
    expect(m).toBeNull();
  });
});
