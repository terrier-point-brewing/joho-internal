// lib/production/exportTransactionWriter.test.ts
//
// The invoice-lifecycle status a freshly written export row starts at depends
// only on its channel: taproom consumption is internal (paid at the point of
// sale) and terminal, every partner channel starts in the invoicing workflow.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { initialExportStatus, writeExportTransaction } from "./exportTransactionWriter";

describe("initialExportStatus", () => {
  it("forwards taproom straight to paid (never enters invoicing)", () => {
    expect(initialExportStatus("taproom")).toBe("paid");
  });

  it("starts every partner channel at invoice_required", () => {
    expect(initialExportStatus("distribution")).toBe("invoice_required");
    expect(initialExportStatus("wholesale")).toBe("invoice_required");
    expect(initialExportStatus("contract_brewing")).toBe("invoice_required");
  });
});

interface RateRow {
  id: string;
  key: string;
  name: string;
  category: string;
  party_key: string | null;
  basis: "per_bbl" | "per_gallon" | "percent";
  rate: number;
  is_active: boolean;
}

const FEDERAL: RateRow = {
  id: "fed",
  key: "federal_beer_excise",
  name: "Federal Beer Excise Tax",
  category: "excise",
  party_key: "federal_ttb",
  basis: "per_bbl",
  rate: 3.5,
  is_active: true,
};

/**
 * Stub covering every table writeExportTransaction touches: `tax_rates` (read,
 * via computeExciseTaxBreakdown → listTaxRates), `export_transactions`
 * (insert + select + single), and `export_transaction_taxes` (insert).
 * Records every insert payload so tests can assert on exactly what was
 * persisted, not just that some mock fired.
 */
function stubSupabase(rates: RateRow[]) {
  const inserted: {
    export_transactions: Record<string, unknown>[];
    export_transaction_taxes: Record<string, unknown>[];
  } = {
    export_transactions: [],
    export_transaction_taxes: [],
  };

  const from = (table: string) => {
    if (table === "tax_rates") {
      const result = Promise.resolve({ data: rates, error: null }) as unknown as {
        select: () => typeof result;
        eq: () => typeof result;
      };
      result.select = () => result;
      result.eq = () => result;
      return result;
    }
    if (table === "export_transactions") {
      return {
        insert: (row: Record<string, unknown>) => {
          inserted.export_transactions.push(row);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: "tx-1" }, error: null }),
            }),
          };
        },
      };
    }
    if (table === "export_transaction_taxes") {
      return {
        insert: (rows: Record<string, unknown>[]) => {
          inserted.export_transaction_taxes.push(...rows);
          return Promise.resolve({ error: null });
        },
      };
    }
    throw new Error(`stubSupabase: unexpected table ${table}`);
  };

  return { client: { from } as unknown as SupabaseClient, inserted };
}

const BASE_PARAMS = {
  shipmentId: "ship-1",
  recipeId: "recipe-1",
  packagingItemId: "pkg-1",
  variantLabel: "1/2 Keg",
  quantity: 1,
  volumeBbl: 10,
  channel: "distribution",
  recipientId: "partner-1",
  recipientName: "Partner Co",
  allocationId: "alloc-1",
  packagingFormat: "keg",
  unitsPerPackage: 1,
};

describe("writeExportTransaction", () => {
  it("inserts a physical row (real batchId, no isPhantom) — is_phantom false, byte-for-byte unchanged", async () => {
    const { client, inserted } = stubSupabase([FEDERAL]);
    const id = await writeExportTransaction(client, { ...BASE_PARAMS, batchId: "batch-1" });

    expect(id).toBe("tx-1");
    expect(inserted.export_transactions).toEqual([
      {
        shipment_id: "ship-1",
        batch_id: "batch-1",
        recipe_id: "recipe-1",
        allocation_id: "alloc-1",
        packaging_item_id: "pkg-1",
        variant_label: "1/2 Keg",
        quantity: 1,
        packaging_format: "keg",
        units_per_package: 1,
        volume_bbl: 10,
        channel: "distribution",
        status: "invoice_required",
        recipient_id: "partner-1",
        recipient_name: "Partner Co",
        total_excise_tax_usd: 35,
        source_transfer_id: null,
        source_ref: null,
        notes: null,
        over_allocation: false,
        is_phantom: false,
        // Defaults to 0 — kegs carry no canning loss, and callers that don't
        // pass one must not silently inflate a Packaging Materials charge.
        packaging_loss_pct: 0,
      },
    ]);
    expect(inserted.export_transaction_taxes).toEqual([
      {
        export_transaction_id: "tx-1",
        excise_tax_rate_id: "fed",
        tax_name: "Federal Beer Excise Tax",
        unit: "bbl",
        rate_usd: 3.5,
        amount_usd: 35,
      },
    ]);
  });

  it("inserts a phantom row with null batchId and is_phantom true, still writing excise tax children", async () => {
    const { client, inserted } = stubSupabase([FEDERAL]);
    const id = await writeExportTransaction(client, {
      ...BASE_PARAMS,
      batchId: null,
      isPhantom: true,
    });

    expect(id).toBe("tx-1");
    expect(inserted.export_transactions).toHaveLength(1);
    expect(inserted.export_transactions[0]).toMatchObject({
      batch_id: null,
      is_phantom: true,
      volume_bbl: 10,
      total_excise_tax_usd: 35,
    });
    expect(inserted.export_transaction_taxes).toEqual([
      {
        export_transaction_id: "tx-1",
        excise_tax_rate_id: "fed",
        tax_name: "Federal Beer Excise Tax",
        unit: "bbl",
        rate_usd: 3.5,
        amount_usd: 35,
      },
    ]);
  });

  it("still rounds volume_bbl to 4dp regardless of phantom flag", async () => {
    const { client, inserted } = stubSupabase([]);
    await writeExportTransaction(client, {
      ...BASE_PARAMS,
      batchId: null,
      isPhantom: true,
      volumeBbl: 0.123456789,
    });
    expect(inserted.export_transactions[0].volume_bbl).toBe(0.1235);
  });
});
