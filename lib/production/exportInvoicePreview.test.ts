// lib/production/exportInvoicePreview.test.ts
//
// Tests the dollars → cents seam in buildExciseTaxLines. export_transaction_taxes
// .amount_usd is a decimal USD column; invoice line unit prices are integer
// cents. buildExciseTaxLines crosses that boundary via dollarsToCents while
// rolling amounts up per receiving_party. We drive it with a thin Supabase stub
// and assert the REAL computed unitPriceCents.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildExciseTaxLines, sumKegCleaningQuantity, resolveInvoiceChannel, packagingFeeDescription, buildPackagingMaterialLines } from "./exportInvoicePreview";

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
          const key = `${filters["recipe_id"]}|${filters["packaging_variations.name"]}`;
          resolve({ data: variationsByKey[key] ?? [], error: null });
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
    container: { name: "12oz Can", unit_cost: 0.15, can_count: null, type: "can" },
    lid: { name: "Lid", unit_cost: 0.05 },
    label: { name: "Label", unit_cost: 0.02 },
    paktech: { name: "PakTech 4", unit_cost: 0.30, can_count: 4 },
    tray: { name: "Tray 24", unit_cost: 0.40, can_count: 24 },
  },
};

function matRows(rows: Array<Partial<{ id: string; recipe_id: string | null; packaging_item_id: string; packaging_format: string | null; quantity: number; units_per_package: number; variant_label: string }>>) {
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
    const pricey = { packaging_variations: { ...caseVariationRow.packaging_variations, label: { name: "Pricey Label", unit_cost: 0.99 } } };
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
        container: { name: "12oz Can", unit_cost: null, can_count: null, type: "can" },
        lid: { name: "Lid", unit_cost: 0.05 },
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
