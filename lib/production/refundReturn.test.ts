import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { writeRefundReturn } from "./refundReturn";

/**
 * The one export transaction behind prod invoice 000042: 30 cases of Pumpkin
 * Ale, 2.9032 bbl, contract brewing.
 */
const SHIPPED = {
  id: "tx1",
  batch_id: "batch1",
  recipe_id: "recipe1",
  allocation_id: "alloc1",
  packaging_item_id: "pkg1",
  variant_label: "CBC Pumpkin Reaper Ale - 16oz Labeled Can Case",
  quantity: 30,
  volume_bbl: 2.9032,
  channel: "contract_brewing",
  recipient_id: "partner1",
  recipient_name: "Argus Beverage Ventures LLC",
  packaging_format: "case",
  units_per_package: 24,
  packaging_loss_pct: 1.5,
};

const TAXES = [
  { excise_tax_rate_id: "ttb", tax_name: "TTB", unit: "bbl", rate_usd: 3.5, amount_usd: 10.16 },
  { excise_tax_rate_id: "nc", tax_name: "NC DOR", unit: "gallon", rate_usd: 0.6171, amount_usd: 55.54 },
];

interface Captured {
  exportInserts: Record<string, unknown>[];
  taxInserts: Record<string, unknown>[];
  coldStorageUpdates: { id: string; quantity_on_hand: number }[];
  coldStorageInserts: Record<string, unknown>[];
}

function fakeClient(opts: {
  shipped?: (typeof SHIPPED)[];
  existingReturn?: boolean;
  coldStorageRow?: { id: string; quantity_on_hand: number } | null;
  variationResolvable?: boolean;
}) {
  const captured: Captured = {
    exportInserts: [],
    taxInserts: [],
    coldStorageUpdates: [],
    coldStorageInserts: [],
  };
  const shipped = opts.shipped ?? [SHIPPED];

  const client = {
    from(table: string) {
      if (table === "export_transactions") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          // The shipment lookup ends in .gt("quantity", 0); the idempotency
          // probe ends in .eq("source_ref", …). Same table, two shapes.
          gt: async () => ({ data: shipped, error: null }),
          eq: (col: string) => (col === "source_ref"
            ? Promise.resolve({ data: opts.existingReturn ? [{ id: "existing" }] : [], error: null })
            : chain),
          insert: (row: Record<string, unknown>) => {
            captured.exportInserts.push(row);
            return {
              select: () => ({
                single: async () => ({ data: { id: `ret${captured.exportInserts.length}` }, error: null }),
              }),
            };
          },
        };
        return chain;
      }
      if (table === "export_transaction_taxes") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: async () => ({ data: TAXES, error: null }),
          insert: async (rows: Record<string, unknown>[]) => {
            captured.taxInserts.push(...rows);
            return { error: null };
          },
        };
        return chain;
      }
      if (table === "recipe_packaging_variations") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (col: string) => (col === "packaging_variations.name"
            ? Promise.resolve({
                data: opts.variationResolvable === false ? [] : [{ variation_id: "var1" }],
                error: null,
              })
            : chain),
        };
        return chain;
      }
      if (table === "cold_storage_inventory") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: opts.coldStorageRow ?? null, error: null }),
          update: (patch: { quantity_on_hand: number }) => ({
            eq: async (_c: string, id: string) => {
              captured.coldStorageUpdates.push({ id, quantity_on_hand: patch.quantity_on_hand });
              return { error: null };
            },
          }),
          insert: async (row: Record<string, unknown>) => {
            captured.coldStorageInserts.push(row);
            return { error: null };
          },
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client: client as unknown as SupabaseClient, captured };
}

const EIGHT_OF_THIRTY = 8 / 30;

describe("writeRefundReturn", () => {
  it("books a negative mirror of the shipment, scaled to the credited fraction", async () => {
    const { client, captured } = fakeClient({ coldStorageRow: { id: "cs1", quantity_on_hand: 4 } });
    const result = await writeRefundReturn(client, {
      refundId: "r1",
      invoiceId: "inv1",
      unitFraction: EIGHT_OF_THIRTY,
      restockInventory: true,
      reverseExcise: true,
    });

    const row = captured.exportInserts[0];
    expect(row.quantity).toBe(-8);
    expect(row.volume_bbl).toBe(-0.7742);
    expect(row.channel).toBe("contract_brewing");
    expect(row.status).toBe("paid");
    expect(row.source_ref).toBe("refund:r1");
    // A return must not hand the partner their allocation entitlement back —
    // that is a separate decision, made in the shipment editor.
    expect(row.allocation_id).toBeNull();
    expect(result.unitsReturned).toBe(8);
  });

  it("reverses the excise that was charged, pro-rated — not today's rates", async () => {
    const { client, captured } = fakeClient({ coldStorageRow: { id: "cs1", quantity_on_hand: 4 } });
    await writeRefundReturn(client, {
      refundId: "r1",
      invoiceId: "inv1",
      unitFraction: EIGHT_OF_THIRTY,
      restockInventory: true,
      reverseExcise: true,
    });

    expect(captured.taxInserts.map((t) => [t.tax_name, t.amount_usd])).toEqual([
      ["TTB", -2.71],
      ["NC DOR", -14.81],
    ]);
    expect(captured.exportInserts[0].total_excise_tax_usd).toBe(-17.52);
  });

  it("writes no tax rows at all when the reason does not reverse excise", async () => {
    const { client, captured } = fakeClient({ coldStorageRow: { id: "cs1", quantity_on_hand: 4 } });
    await writeRefundReturn(client, {
      refundId: "r1",
      invoiceId: "inv1",
      unitFraction: EIGHT_OF_THIRTY,
      restockInventory: true,
      reverseExcise: false,
    });
    expect(captured.taxInserts).toEqual([]);
    expect(captured.exportInserts[0].total_excise_tax_usd).toBe(0);
  });

  it("adds the units back to the batch's existing cold-storage lot", async () => {
    const { client, captured } = fakeClient({ coldStorageRow: { id: "cs1", quantity_on_hand: 4 } });
    await writeRefundReturn(client, {
      refundId: "r1",
      invoiceId: "inv1",
      unitFraction: EIGHT_OF_THIRTY,
      restockInventory: true,
      reverseExcise: true,
    });
    expect(captured.coldStorageUpdates).toEqual([{ id: "cs1", quantity_on_hand: 12 }]);
  });

  it("recreates the lot when the shipment had emptied it", async () => {
    const { client, captured } = fakeClient({ coldStorageRow: null });
    await writeRefundReturn(client, {
      refundId: "r1",
      invoiceId: "inv1",
      unitFraction: EIGHT_OF_THIRTY,
      restockInventory: true,
      reverseExcise: true,
    });
    expect(captured.coldStorageInserts[0]).toMatchObject({
      batch_id: "batch1",
      variation_id: "var1",
      quantity_on_hand: 8,
    });
  });

  it("reverses the paperwork but restocks nothing when the beer never left", async () => {
    const { client, captured } = fakeClient({ coldStorageRow: { id: "cs1", quantity_on_hand: 4 } });
    await writeRefundReturn(client, {
      refundId: "r1",
      invoiceId: "inv1",
      unitFraction: EIGHT_OF_THIRTY,
      restockInventory: false,
      reverseExcise: true,
    });
    expect(captured.exportInserts).toHaveLength(1);
    expect(captured.coldStorageUpdates).toEqual([]);
    expect(captured.coldStorageInserts).toEqual([]);
  });

  it("warns instead of restocking when the packaging variation can't be resolved", async () => {
    const { client, captured } = fakeClient({
      coldStorageRow: { id: "cs1", quantity_on_hand: 4 },
      variationResolvable: false,
    });
    const result = await writeRefundReturn(client, {
      refundId: "r1",
      invoiceId: "inv1",
      unitFraction: EIGHT_OF_THIRTY,
      restockInventory: true,
      reverseExcise: true,
    });
    expect(captured.coldStorageUpdates).toEqual([]);
    expect(result.warnings[0]).toMatch(/Link Styles to Square/);
  });

  it("is idempotent — a retry after a partial failure returns nothing twice", async () => {
    const { client, captured } = fakeClient({ existingReturn: true });
    const result = await writeRefundReturn(client, {
      refundId: "r1",
      invoiceId: "inv1",
      unitFraction: EIGHT_OF_THIRTY,
      restockInventory: true,
      reverseExcise: true,
    });
    expect(captured.exportInserts).toEqual([]);
    expect(result.warnings[0]).toMatch(/already written/);
  });

  it("does nothing at all when nothing was credited", async () => {
    const { client, captured } = fakeClient({});
    const result = await writeRefundReturn(client, {
      refundId: "r1",
      invoiceId: "inv1",
      unitFraction: 0,
      restockInventory: true,
      reverseExcise: true,
    });
    expect(captured.exportInserts).toEqual([]);
    expect(result.unitsReturned).toBe(0);
  });
});
