// lib/production/writePhantomExport.test.ts
//
// A phantom export is a batch-less export_transactions row written for a
// taproom draft-restock keg swap when cold storage has no matching batch to
// physically deplete. It must always book excise — but it must NEVER touch
// cold_storage_inventory (there is no physical stock movement to record).
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { writePhantomExport } from "./writePhantomExport";

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

const VARIATION = {
  total_volume_fl_oz: 1984, // half keg
  container_id: "container-1",
  name: "1/2 Keg",
  format: "keg",
  tray_id: null,
  paktech_id: null,
};

/**
 * Stub covering every table writePhantomExport (transitively via
 * writeExportTransaction) touches: `packaging_variations` (read), `tax_rates`
 * (read, via computeExciseTaxBreakdown), `export_transactions` (insert +
 * select + single), `export_transaction_taxes` (insert). Records every table
 * name `from()` is called with so tests can assert `cold_storage_inventory`
 * is never touched, plus every insert payload.
 */
function stubSupabase(opts: { variation?: Record<string, unknown> | null; rates?: RateRow[] } = {}) {
  const variation = opts.variation === undefined ? VARIATION : opts.variation;
  const rates = opts.rates ?? [FEDERAL];

  const calledTables: string[] = [];
  const inserted: {
    export_transactions: Record<string, unknown>[];
    export_transaction_taxes: Record<string, unknown>[];
  } = { export_transactions: [], export_transaction_taxes: [] };

  const from = (table: string) => {
    calledTables.push(table);

    if (table === "packaging_variations") {
      return {
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: variation, error: null }),
          }),
        }),
      };
    }
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

  return { client: { from } as unknown as SupabaseClient, inserted, calledTables };
}

const BASE_PARAMS = {
  recipeId: "recipe-1",
  variationId: "var-1",
  quantityKegs: 1,
  sourceRef: "square:order-123",
};

describe("writePhantomExport", () => {
  it("computes volume_bbl from quantityKegs * total_volume_fl_oz / BBL_TO_FL_OZ (half keg -> 0.5 bbl)", async () => {
    const { client, inserted } = stubSupabase();

    const result = await writePhantomExport(client, BASE_PARAMS);

    expect(result.exportTransactionId).toBe("tx-1");
    expect(inserted.export_transactions).toHaveLength(1);
    expect(inserted.export_transactions[0]).toMatchObject({
      batch_id: null,
      is_phantom: true,
      channel: "taproom",
      status: "paid",
      volume_bbl: 0.5,
      packaging_item_id: "container-1",
      variant_label: "1/2 Keg",
      quantity: 1,
      allocation_id: null,
      source_ref: "square:order-123",
    });
    // excise children present
    expect(inserted.export_transaction_taxes).toEqual([
      {
        export_transaction_id: "tx-1",
        excise_tax_rate_id: "fed",
        tax_name: "Federal Beer Excise Tax",
        unit: "bbl",
        rate_usd: 3.5,
        amount_usd: 1.75, // 0.5 bbl * $3.5
      },
    ]);
  });

  it("creates a new shipment id when none is passed", async () => {
    const { client, inserted } = stubSupabase();

    const result = await writePhantomExport(client, BASE_PARAMS);

    expect(typeof result.shipmentId).toBe("string");
    expect(result.shipmentId.length).toBeGreaterThan(0);
    expect(inserted.export_transactions[0].shipment_id).toBe(result.shipmentId);
  });

  it("reuses a passed shipmentId instead of creating a new one", async () => {
    const { client, inserted } = stubSupabase();

    const result = await writePhantomExport(client, { ...BASE_PARAMS, shipmentId: "existing-shipment-1" });

    expect(result.shipmentId).toBe("existing-shipment-1");
    expect(inserted.export_transactions[0].shipment_id).toBe("existing-shipment-1");
  });

  it("never writes to cold_storage_inventory", async () => {
    const { client, calledTables } = stubSupabase();

    await writePhantomExport(client, BASE_PARAMS);

    expect(calledTables).not.toContain("cold_storage_inventory");
  });
});
