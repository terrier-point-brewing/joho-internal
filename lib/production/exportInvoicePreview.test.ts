// lib/production/exportInvoicePreview.test.ts
//
// Tests the dollars → cents seam in buildExciseTaxLines. export_transaction_taxes
// .amount_usd is a decimal USD column; invoice line unit prices are integer
// cents. buildExciseTaxLines crosses that boundary via dollarsToCents while
// rolling amounts up per receiving_party. We drive it with a thin Supabase stub
// and assert the REAL computed unitPriceCents.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildExciseTaxLines, sumKegCleaningQuantity } from "./exportInvoicePreview";

interface TaxRow {
  export_transaction_id: string;
  amount_usd: number;
  excise_tax_rate_id: string | null;
}
interface RateRow {
  id: string;
  receiving_party: string;
  unit: string;
  square_catalog_variation_id: string | null;
}

/** Stub dispatching by table: export_transaction_taxes → taxRows, excise_tax_rates → rates. */
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
        [{ id: "fed", receiving_party: "Federal", unit: "bbl", square_catalog_variation_id: "var-fed" }]
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
        [{ id: "fed", receiving_party: "Federal", unit: "bbl", square_catalog_variation_id: "var-fed" }]
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
          { id: "fed", receiving_party: "Federal", unit: "bbl", square_catalog_variation_id: "var-fed" },
          { id: "nc", receiving_party: "NC", unit: "gallon", square_catalog_variation_id: "var-nc" },
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
