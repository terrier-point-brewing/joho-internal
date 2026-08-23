// lib/production/exportInvoicePreview.test.ts
//
// Tests the dollars → cents seam in buildExciseTaxLines. export_transaction_taxes
// .amount_usd is a decimal USD column; invoice line unit prices are integer
// cents. buildExciseTaxLines crosses that boundary via dollarsToCents while
// rolling amounts up per receiving_party. We drive it with a thin Supabase stub
// and assert the REAL computed unitPriceCents.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildExciseTaxLines, sumKegCleaningQuantity, resolveInvoiceChannel, packagingFeeDescription, buildPackagingMaterialLines, buildProductLines, groupPackagingFeeRows } from "./exportInvoicePreview";

interface TaxRow {
  export_transaction_id: string;
  amount_usd: number;
  excise_tax_rate_id: string | null;
}
interface RateRow {
  id: string;
  receiving_party: string;
  basis: string;
  square_catalog_variation_id: string | null;
}

/** Stub dispatching by table: export_transaction_taxes → taxRows, tax_rates → rates. */
function stub(taxRows: TaxRow[], rates: RateRow[]): SupabaseClient {
  const client = {
    from(table: string) {
      const data = table === "export_transaction_taxes" ? taxRows : rates;
      return { select: () => ({ in: () => Promise.resolve({ data, error: null }) }) };
    },
  };
  return client as unknown as SupabaseClient;
}

// Minimal ExportTxRow shape — only id + volume_bbl are read by buildExciseTaxLines.
function rows(vols: Record<string, number>) {
  return Object.entries(vols).map(([id, volume_bbl]) => ({
    id,
    volume_bbl,
  })) as unknown as Parameters<typeof buildExciseTaxLines>[2];
}

describe("buildExciseTaxLines", () => {
  it("converts a single amount_usd to cents (round to nearest cent)", async () => {
    // $0.6171 → dollarsToCents → round(61.71) = 62 cents.
    const lines = await buildExciseTaxLines(
      stub(
        [{ export_transaction_id: "t1", amount_usd: 0.6171, excise_tax_rate_id: "fed" }],
        [{ id: "fed", receiving_party: "Federal", basis: "per_bbl", square_catalog_variation_id: "var-fed" }]
      ),
      ["t1"],
      rows({ t1: 5 })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].unitPriceCents).toBe(62);
    expect(Number.isInteger(lines[0].unitPriceCents)).toBe(true);
    expect(lines[0].quantity).toBe(1);
    expect(lines[0].squareCatalogVariationId).toBe("var-fed");
  });

  it("rolls up multiple amounts for the same receiving_party, summing in cents", async () => {
    // $12.34 → 1234 ; $0.6171 → 62 ; total 1296 cents on one Federal line.
    const lines = await buildExciseTaxLines(
      stub(
        [
          { export_transaction_id: "t1", amount_usd: 12.34, excise_tax_rate_id: "fed" },
          { export_transaction_id: "t2", amount_usd: 0.6171, excise_tax_rate_id: "fed" },
        ],
        [{ id: "fed", receiving_party: "Federal", basis: "per_bbl", square_catalog_variation_id: "var-fed" }]
      ),
      ["t1", "t2"],
      rows({ t1: 5, t2: 3 })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].unitPriceCents).toBe(1296);
    expect(lines[0].description).toContain("Federal");
  });

  it("emits one line per distinct receiving_party", async () => {
    const lines = await buildExciseTaxLines(
      stub(
        [
          { export_transaction_id: "t1", amount_usd: 10, excise_tax_rate_id: "fed" },
          { export_transaction_id: "t1", amount_usd: 2.5, excise_tax_rate_id: "nc" },
        ],
        [
          { id: "fed", receiving_party: "Federal", basis: "per_bbl", square_catalog_variation_id: "var-fed" },
          { id: "nc", receiving_party: "NC", basis: "per_gallon", square_catalog_variation_id: "var-nc" },
        ]
      ),
      ["t1"],
      rows({ t1: 2 })
    );
    const byParty = Object.fromEntries(
      lines.map((l) => [l.description.split(" — ")[1].split(" (")[0], l.unitPriceCents])
    );
    expect(byParty.Federal).toBe(1000);
    expect(byParty.NC).toBe(250);
  });

  it("returns no lines when there are no tax rows", async () => {
    const lines = await buildExciseTaxLines(stub([], []), ["t1"], rows({ t1: 1 }));
    expect(lines).toEqual([]);
  });
});

describe("sumKegCleaningQuantity", () => {
  const pkgTypeById = new Map<string, string>([
    ["keg-half", "keg"],
    ["keg-sixtel", "keg"],
    ["can-12oz", "can"],
  ]);
  const txn = (packaging_item_id: string, quantity: number) => ({
    packaging_item_id,
    quantity,
  });

  it("sums the keg counts across keg-type transactions, not the transaction count", () => {
    // Two keg transactions of 6 and 4 kegs → cleaning qty 10 (not 2).
    const qty = sumKegCleaningQuantity(
      [txn("keg-half", 6), txn("keg-sixtel", 4)],
      pkgTypeById
    );
    expect(qty).toBe(10);
  });

  it("ignores non-keg (can) transactions", () => {
    const qty = sumKegCleaningQuantity(
      [txn("keg-half", 5), txn("can-12oz", 100)],
      pkgTypeById
    );
    expect(qty).toBe(5);
  });

  it("returns 0 when there are no keg transactions", () => {
    const qty = sumKegCleaningQuantity([txn("can-12oz", 40)], pkgTypeById);
    expect(qty).toBe(0);
  });

  it("returns 0 for an empty selection", () => {
    expect(sumKegCleaningQuantity([], pkgTypeById)).toBe(0);
  });

  it("treats an unmapped packaging item as non-keg", () => {
    const qty = sumKegCleaningQuantity([txn("mystery", 3)], pkgTypeById);
    expect(qty).toBe(0);
  });
});

describe("groupPackagingFeeRows", () => {
  const pkgTypeById = new Map<string, string>([
    ["keg-half", "keg"],
    ["can-12", "can"],
  ]);
  type Row = Parameters<typeof groupPackagingFeeRows>[0][number];
  const row = (r: Partial<Row>): Row => ({
    recipe_id: "r1", packaging_item_id: "can-12", packaging_format: "case",
    quantity: 1, units_per_package: 24, ...r,
  } as Row);

  it("collapses a shipment split across commitments into one charge unit", () => {
    // Prod case: 16 half-kegs of Pumpkin Ale drawn from two commitments
    // (5.8034 + 10.1966). One packaging run → one fee line at 16.
    const groups = groupPackagingFeeRows(
      [
        row({ packaging_item_id: "keg-half", packaging_format: null, units_per_package: 1, quantity: 5.8034 }),
        row({ packaging_item_id: "keg-half", packaging_format: null, units_per_package: 1, quantity: 10.1966 }),
      ],
      pkgTypeById
    );
    expect(groups).toEqual([
      { recipeId: "r1", packagingItemId: "keg-half", mapFormat: null, quantity: 16, unitsPerPackage: 1 },
    ]);
  });

  it("sums case quantities BEFORE the whole/partial split so halves don't each round down", () => {
    // 2.5 + 2.5 cases must bill as 5 whole cases, not 2 cases + 12 loose, twice.
    const groups = groupPackagingFeeRows(
      [row({ quantity: 2.5 }), row({ quantity: 2.5 })],
      pkgTypeById
    );
    expect(groups).toEqual([
      { recipeId: "r1", packagingItemId: "can-12", mapFormat: "case", quantity: 5, unitsPerPackage: 24 },
    ]);
  });

  it("keeps separate groups per recipe, packaging item, and format", () => {
    const groups = groupPackagingFeeRows(
      [
        row({ quantity: 2 }),
        row({ recipe_id: "r2", quantity: 3 }),
        row({ packaging_format: "loose", quantity: 4 }),
        row({ packaging_item_id: "keg-half", packaging_format: null, quantity: 5 }),
      ],
      pkgTypeById
    );
    expect(groups.map((g) => [g.recipeId, g.packagingItemId, g.mapFormat, g.quantity])).toEqual([
      ["r1", "can-12", "case", 2],
      ["r2", "can-12", "case", 3],
      ["r1", "can-12", "loose", 4],
      ["r1", "keg-half", null, 5],
    ]);
  });

  it("treats kegs as formatless and defaults a can with no format to loose", () => {
    const groups = groupPackagingFeeRows(
      [
        row({ packaging_item_id: "keg-half", packaging_format: "case", quantity: 6 }),
        row({ packaging_format: null, quantity: 7 }),
      ],
      pkgTypeById
    );
    expect(groups.map((g) => g.mapFormat)).toEqual([null, "loose"]);
  });

  it("returns nothing for an empty selection", () => {
    expect(groupPackagingFeeRows([], pkgTypeById)).toEqual([]);
  });
});

describe("resolveInvoiceChannel", () => {
  it("returns the shared stored channel when there is no override", () => {
    expect(resolveInvoiceChannel(["distribution", "distribution"])).toEqual({
      shippedChannel: "distribution",
      channel: "distribution",
    });
  });
  it("throws on mixed stored channels when there is no override", () => {
    expect(() => resolveInvoiceChannel(["distribution", "wholesale"])).toThrow(/same channel/i);
  });
  it("allows mixed stored channels when an override is supplied, reporting shippedChannel='mixed'", () => {
    expect(resolveInvoiceChannel(["distribution", "wholesale"], "contract_brewing")).toEqual({
      shippedChannel: "mixed",
      channel: "contract_brewing",
    });
  });
  it("uses the override as the effective channel and keeps the single stored channel as shippedChannel", () => {
    expect(resolveInvoiceChannel(["distribution"], "contract_brewing")).toEqual({
      shippedChannel: "distribution",
      channel: "contract_brewing",
    });
  });
});

// Stub the recipe_packaging_variations resolve query. Each call chains
// .select(...).eq().eq() and is awaited (thenable) → we return the variation keyed
// by (recipe_id, variant_label) — the literal shipped variation the resolver
// matches on packaging_variations.name.
function pvStub(variationsByKey: Record<string, unknown[]>): SupabaseClient {
  const client = {
    from(_table: string) {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select() { return chain; },
        eq(col: string, val: unknown) { filters[col] = val; return chain; },
        then(resolve: (r: { data: unknown[]; error: null }) => void) {
          // Two queries now: resolveShippedVariationId matches the legacy label
          // to a variation id, then the slot fetch keys on that id. The stub
          // uses the composite key itself as the id so the fixtures are unchanged.
          if (filters["variation_id"] !== undefined) {
            resolve({ data: variationsByKey[filters["variation_id"] as string] ?? [], error: null });
            return;
          }
          const key = `${filters["recipe_id"]}|${filters["packaging_variations.name"]}`;
          resolve({ data: variationsByKey[key] ? [{ variation_id: key }] : [], error: null });
        },
      };
      return chain;
    },
  };
  return client as unknown as SupabaseClient;
}

// One case variation: 12oz can $0.15, lid $0.05, label $0.02, paktech(4) $0.30, tray(24) $0.40
const caseVariationRow = {
  packaging_variations: {
    container: { name: "12oz Can", unit_cost_usd: 0.15, can_count: null, type: "can" },
    lid: { name: "Lid", unit_cost_usd: 0.05 },
    label: { name: "Label", unit_cost_usd: 0.02 },
    paktech: { name: "PakTech 4", unit_cost_usd: 0.30, can_count: 4 },
    tray: { name: "Tray 24", unit_cost_usd: 0.40, can_count: 24 },
  },
};

function matRows(rows: Array<Partial<{ id: string; recipe_id: string | null; variation_id: string | null; packaging_item_id: string; packaging_format: string | null; quantity: number; units_per_package: number; variant_label: string }>>) {
  return rows as unknown as Parameters<typeof buildPackagingMaterialLines>[1];
}

describe("buildPackagingMaterialLines", () => {
  const pkgType = new Map([["can-12", "can"], ["keg-half", "keg"]]);
  const pkgName = new Map([["can-12", "12oz Can"], ["keg-half", "1/2 BBL Keg"]]);
  const recipeName = new Map([["r1", "Fortnight"]]);
  const CASE_LABEL = "Fortnight - 16oz Case";

  it("emits one materials line per recipe at the summed cost, named by beer", async () => {
    const supabase = pvStub({ [`r1|${CASE_LABEL}`]: [caseVariationRow] });
    const { lines, warnings } = await buildPackagingMaterialLines(
      supabase,
      matRows([{ id: "t1", recipe_id: "r1", packaging_item_id: "can-12", packaging_format: "case", quantity: 2, units_per_package: 24, variant_label: CASE_LABEL }]),
      pkgType, pkgName, recipeName, "var-mat",
    );
    // Same math as computeMaterialCost case test: 1496 cents.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ description: "Packaging Materials — Fortnight", quantity: 1, unitPriceCents: 1496, squareCatalogVariationId: "var-mat" });
    expect(warnings).toEqual([]);
  });

  it("resolves the LITERAL shipped variation by variant_label, not container+format", async () => {
    // Two label-variants share the same can + case format; the export shipped the
    // pricier-label one. Matching by variant_label must pick THAT variation's cost,
    // never the other. Pricey label $0.99 vs base $0.02 → 48 cans × extra 97¢ = +4656¢.
    const pricey = { packaging_variations: { ...caseVariationRow.packaging_variations, label: { name: "Pricey Label", unit_cost_usd: 0.99 } } };
    const supabase = pvStub({
      "r1|Fortnight Cheap Case": [caseVariationRow],   // label $0.02
      "r1|Fortnight Pricey Case": [pricey],            // label $0.99
    });
    const { lines } = await buildPackagingMaterialLines(
      supabase,
      matRows([{ id: "t1", recipe_id: "r1", packaging_item_id: "can-12", packaging_format: "case", quantity: 2, units_per_package: 24, variant_label: "Fortnight Pricey Case" }]),
      pkgType, pkgName, recipeName, null,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].unitPriceCents).toBe(6152); // 1496 base + 4656 (pricey label) — proves it picked the shipped variation
  });

  it("skips keg-type transactions", async () => {
    const supabase = pvStub({});
    const { lines } = await buildPackagingMaterialLines(
      supabase,
      matRows([{ id: "t1", recipe_id: "r1", packaging_item_id: "keg-half", packaging_format: "loose", quantity: 6, units_per_package: 1, variant_label: "1/2 Keg" }]),
      pkgType, pkgName, recipeName, null,
    );
    expect(lines).toEqual([]);
  });

  it("warns and skips (no throw) when the shipped variation can't be resolved", async () => {
    const supabase = pvStub({}); // variant_label matches nothing (e.g. renamed variation)
    const { lines, warnings } = await buildPackagingMaterialLines(
      supabase,
      matRows([{ id: "t1", recipe_id: "r1", packaging_item_id: "can-12", packaging_format: "case", quantity: 2, units_per_package: 24, variant_label: "Ghost Case" }]),
      pkgType, pkgName, recipeName, null,
    );
    expect(lines).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Couldn't resolve packaging materials for Fortnight \("Ghost Case"\)/);
  });

  it("surfaces a missing-cost warning while still billing the priced components", async () => {
    const noCostCanVariation = {
      packaging_variations: {
        container: { name: "12oz Can", unit_cost_usd: null, can_count: null, type: "can" },
        lid: { name: "Lid", unit_cost_usd: 0.05 },
        label: null, paktech: null, tray: null,
      },
    };
    const supabase = pvStub({ "r1|Fortnight Loose": [noCostCanVariation] });
    const { lines, warnings } = await buildPackagingMaterialLines(
      supabase,
      matRows([{ id: "t1", recipe_id: "r1", packaging_item_id: "can-12", packaging_format: "loose", quantity: 100, units_per_package: 1, variant_label: "Fortnight Loose" }]),
      pkgType, pkgName, recipeName, null,
    );
    // cans $0, lids 100 × 5 = 500
    expect(lines[0].unitPriceCents).toBe(500);
    expect(warnings.some((w) => w.includes("12oz Can") && w.includes("$0"))).toBe(true);
  });

  it("merges commitment-split rows into one packaging run before rounding components", () => {
    // 2 cases shipped as 1.5 + 0.5 against two commitments. Rounding each split
    // separately would consume 36 + 12 cans; merged it is exactly 48 → 1496¢.
    const supabase = pvStub({ [`r1|${CASE_LABEL}`]: [caseVariationRow] });
    return buildPackagingMaterialLines(
      supabase,
      matRows([
        { id: "t1", recipe_id: "r1", packaging_item_id: "can-12", packaging_format: "case", quantity: 1.5, units_per_package: 24, variant_label: CASE_LABEL },
        { id: "t2", recipe_id: "r1", packaging_item_id: "can-12", packaging_format: "case", quantity: 0.5, units_per_package: 24, variant_label: CASE_LABEL },
      ]),
      pkgType, pkgName, recipeName, "var-mat",
    ).then(({ lines, breakdowns }) => {
      expect(lines).toHaveLength(1);
      expect(lines[0].unitPriceCents).toBe(1496);
      // One breakdown entry for the merged run, not one per transaction.
      const b = breakdowns[lines[0].id];
      expect(b.beerName).toBe("Fortnight");
      expect(b.transactions).toHaveLength(1);
      expect(b.transactions[0]).toMatchObject({ label: CASE_LABEL, packages: 2, subtotalCents: 1496 });
    });
  });

  it("returns a per-line breakdown keyed by line id that sums to the charged amount", async () => {
    const supabase = pvStub({ [`r1|${CASE_LABEL}`]: [caseVariationRow] });
    const { lines, breakdowns } = await buildPackagingMaterialLines(
      supabase,
      matRows([{ id: "t1", recipe_id: "r1", packaging_item_id: "can-12", packaging_format: "case", quantity: 2, units_per_package: 24, variant_label: CASE_LABEL }]),
      pkgType, pkgName, recipeName, "var-mat",
    );
    const b = breakdowns[lines[0].id];
    expect(b.totalCents).toBe(lines[0].unitPriceCents);
    expect(b.transactions[0].components.map((c) => c.role)).toEqual(["container", "lid", "label", "paktech", "tray"]);
  });

  it("keeps separate breakdown entries for different variations on one recipe", async () => {
    const looseVariation = {
      packaging_variations: {
        container: { name: "12oz Can", unit_cost_usd: 0.15, can_count: null, type: "can" },
        lid: { name: "Lid", unit_cost_usd: 0.05 }, label: null, paktech: null, tray: null,
      },
    };
    const supabase = pvStub({ [`r1|${CASE_LABEL}`]: [caseVariationRow], "r1|Fortnight Loose": [looseVariation] });
    const { lines, breakdowns } = await buildPackagingMaterialLines(
      supabase,
      matRows([
        { id: "t1", recipe_id: "r1", packaging_item_id: "can-12", packaging_format: "case", quantity: 2, units_per_package: 24, variant_label: CASE_LABEL },
        { id: "t2", recipe_id: "r1", packaging_item_id: "can-12", packaging_format: "loose", quantity: 100, units_per_package: 1, variant_label: "Fortnight Loose" },
      ]),
      pkgType, pkgName, recipeName, null,
    );
    // One line for the recipe, two runs inside it: 1496 + (100 × 20¢) = 3496.
    expect(lines).toHaveLength(1);
    expect(lines[0].unitPriceCents).toBe(3496);
    expect(breakdowns[lines[0].id].transactions.map((t) => t.label)).toEqual([CASE_LABEL, "Fortnight Loose"]);
  });
});

// Stub the two queries buildProductLines drives, dispatched by chained filters:
//  1. recipe_packaging_variations resolve — awaited (thenable), keyed by
//     (recipe_id, variant_label = packaging_variations.name) → [{ variation_id }].
//  2. recipe_square_links resolve inside resolveProductSku — .maybeSingle(),
//     keyed by (variation_id, recipe_id) → the product SKU row (or null).
function productStub(opts: {
  pvByKey: Record<string, Array<{ variation_id: string }>>;
  skuByKey: Record<string, { square_variation_id: string; square_item_id?: string | null; catalog_variation_id?: string | null; item_name?: string | null; variation_name?: string | null } | null>;
}): SupabaseClient {
  const client = {
    from(_table: string) {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select() { return chain; },
        eq(col: string, val: unknown) { filters[col] = val; return chain; },
        maybeSingle() {
          const key = `${filters["variation_id"]}|${filters["recipe_id"]}`;
          return Promise.resolve({ data: opts.skuByKey[key] ?? null, error: null });
        },
        then(resolve: (r: { data: unknown[]; error: null }) => void) {
          const key = `${filters["recipe_id"]}|${filters["packaging_variations.name"]}`;
          resolve({ data: opts.pvByKey[key] ?? [], error: null });
        },
      };
      return chain;
    },
  };
  return client as unknown as SupabaseClient;
}

function prodRows(rows: Array<Partial<{ id: string; recipe_id: string | null; variation_id: string | null; packaging_item_id: string; packaging_format: string | null; quantity: number; variant_label: string }>>) {
  return rows as unknown as Parameters<typeof buildProductLines>[1];
}

describe("buildProductLines", () => {
  const pkgName = new Map([["can-16", "16oz Blank Can"]]);

  it("resolves the LITERAL shipped label-variant by variant_label, not container+format", async () => {
    // Prod case: recipe "Pumpkin Ale" links TWO labeled-can variations sharing the
    // same 16oz can + case format. Matching by variant_label must pick the shipped
    // one (CBC Pumpkin Reaper), never the sibling Fortnight variation.
    const supabase = productStub({
      pvByKey: {
        "pumpkin|Fortnight Pumpkin Ale - 16oz Labeled Can Case": [{ variation_id: "pv-fortnight" }],
        "pumpkin|CBC Pumpkin Reaper Ale - 16oz Labeled Can Case": [{ variation_id: "pv-cbc" }],
      },
      skuByKey: {
        "pv-cbc|pumpkin": { square_variation_id: "sq-cbc", item_name: "CBC Pumpkin Reaper Ale", variation_name: "16oz Can (Case)" },
        "pv-fortnight|pumpkin": { square_variation_id: "sq-fortnight", item_name: "Fortnight Pumpkin Ale", variation_name: "16oz Can (Case)" },
      },
    });
    const lines = await buildProductLines(
      supabase,
      prodRows([{ id: "t1", recipe_id: "pumpkin", packaging_item_id: "can-16", packaging_format: "case", quantity: 4, variant_label: "CBC Pumpkin Reaper Ale - 16oz Labeled Can Case" }]),
      new Map([["sq-cbc", 4500]]),
      pkgName,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 4, unitPriceCents: 4500, squareCatalogVariationId: "sq-cbc" });
    expect(lines[0].description).toBe("CBC Pumpkin Reaper Ale · 16oz Can (Case) (case)");
  });

  it("resolves by variation_id, ignoring a variant_label the rename left stale", async () => {
    // The Aug 2026 prod break: "Fortnight Octoberfest…" was renamed, orphaning
    // the shipment. With variation_id stamped, the dead label is just history.
    const supabase = productStub({
      pvByKey: {},  // no name matches anything any more
      skuByKey: {
        "pv-oktoberfest|oktoberfest": { square_variation_id: "sq-okt", item_name: "Fortnight Oktoberfest", variation_name: "16oz Can (Case)" },
      },
    });
    const lines = await buildProductLines(
      supabase,
      prodRows([{ id: "t1", recipe_id: "oktoberfest", variation_id: "pv-oktoberfest", packaging_item_id: "can-16", packaging_format: "case", quantity: 30, variant_label: "Fortnight Octoberfest - 16 oz Labeled can - 16oz Labeled Can Case" }]),
      new Map([["sq-okt", 3000]]),
      pkgName,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 30, unitPriceCents: 3000, squareCatalogVariationId: "sq-okt" });
  });

  it("throws (fail-closed) when the shipped variant_label resolves to no variation", async () => {
    const supabase = productStub({ pvByKey: {}, skuByKey: {} }); // renamed/removed variation
    await expect(
      buildProductLines(
        supabase,
        prodRows([{ id: "t1", recipe_id: "pumpkin", packaging_item_id: "can-16", packaging_format: "case", quantity: 4, variant_label: "Ghost Case" }]),
        new Map(),
        pkgName,
      )
    ).rejects.toThrow(/Cannot resolve the packaging variation "Ghost Case"/);
  });

  it("drafts an unpriced, flagged line when the variation has no Square product link", async () => {
    // Prod case: Oktoberfest filled into Fortnight's own kegs. The variation must
    // never carry a Square SKU (it would become sellable), but the shipment still
    // bills — as a line the operator points at a substitute item.
    const supabase = productStub({
      pvByKey: { "okt|Fortnight - 1/6 Keg": [{ variation_id: "pv-fortnight-sixtel" }] },
      skuByKey: { "pv-fortnight-sixtel|okt": null }, // no recipe_square_links row
    });
    const lines = await buildProductLines(
      supabase,
      prodRows([{ id: "t1", recipe_id: "okt", packaging_item_id: "keg-sixtel", packaging_format: "loose", quantity: 20, variant_label: "Fortnight - 1/6 Keg" }]),
      new Map(),
      pkgName,
      new Map([["okt", "Oktoberfest"]]),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      quantity: 20,
      unitPriceCents: 0,
      squareCatalogVariationId: null,
      needsSquareItem: true,
    });
    expect(lines[0].description).toBe("Oktoberfest · Fortnight - 1/6 Keg (loose)");
  });

  it("leaves linked lines unflagged, so only the unlinked one gates generation", async () => {
    const supabase = productStub({
      pvByKey: {
        "okt|1/6 Keg": [{ variation_id: "pv-house-sixtel" }],
        "okt|Fortnight - 1/6 Keg": [{ variation_id: "pv-fortnight-sixtel" }],
      },
      skuByKey: {
        "pv-house-sixtel|okt": { square_variation_id: "sq-okt-sixtel", item_name: "Oktoberfest (Keg)", variation_name: "1/6 Keg" },
        "pv-fortnight-sixtel|okt": null,
      },
    });
    const lines = await buildProductLines(
      supabase,
      prodRows([
        { id: "t1", recipe_id: "okt", packaging_item_id: "keg-sixtel", packaging_format: "loose", quantity: 20, variant_label: "1/6 Keg" },
        { id: "t2", recipe_id: "okt", packaging_item_id: "keg-sixtel", packaging_format: "loose", quantity: 20, variant_label: "Fortnight - 1/6 Keg" },
      ]),
      new Map([["sq-okt-sixtel", 8500]]),
      pkgName,
      new Map([["okt", "Oktoberfest"]]),
    );
    expect(lines.map((l) => l.needsSquareItem)).toEqual([undefined, true]);
    expect(lines[0]).toMatchObject({ unitPriceCents: 8500, squareCatalogVariationId: "sq-okt-sixtel" });
  });

  it("throws when a selected transaction has no recipe", async () => {
    const supabase = productStub({ pvByKey: {}, skuByKey: {} });
    await expect(
      buildProductLines(
        supabase,
        prodRows([{ id: "t1", recipe_id: null, packaging_item_id: "can-16", packaging_format: "case", quantity: 4, variant_label: "Whatever" }]),
        new Map(),
        pkgName,
      )
    ).rejects.toThrow(/has no recipe/);
  });
});

describe("packagingFeeDescription", () => {
  it("appends the recipe name so multi-recipe invoices disambiguate each fee", () => {
    expect(packagingFeeDescription("Packaging Fee", "Fortnight")).toBe(
      "Packaging Fee — Fortnight"
    );
  });

  it("falls back to the bare display name when there is no recipe", () => {
    expect(packagingFeeDescription("Packaging Fee", null)).toBe("Packaging Fee");
    expect(packagingFeeDescription("Packaging Fee", undefined)).toBe("Packaging Fee");
    expect(packagingFeeDescription("Packaging Fee", "")).toBe("Packaging Fee");
  });
});
