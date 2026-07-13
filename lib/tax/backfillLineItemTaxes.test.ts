import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Order } from "@/types/square";
import { backfillLineItemTaxesForRange } from "./backfillLineItemTaxes";

interface Recorded {
  table: string;
  op: "delete" | "insert";
  payload?: unknown;
  filterIn?: unknown;
}

/**
 * Minimal Supabase stub covering exactly the query chains the orchestration
 * exercises: a `square_orders` select (gte/lt/is), a `pos_line_items` select
 * (in), and `pos_line_item_taxes` delete (in) + insert. Records every
 * delete/insert so tests can assert the real payload and ordering.
 */
function stub(opts: {
  orderRows: { id: string; square_order_id: string }[];
  lineRows: { id: string; order_id: string; square_line_item_uid: string | null }[];
  deleteError?: string;
  insertError?: string;
}): { client: SupabaseClient; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const from = (table: string) => {
    if (table === "square_orders") {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.gte = () => b;
      b.lt = () => b;
      b.is = () => b;
      b.order = () => b;
      b.range = (from: number, to: number) =>
        Promise.resolve({ data: opts.orderRows.slice(from, to + 1), error: null });
      return b;
    }
    if (table === "pos_line_items") {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.in = () => b;
      b.order = () => b;
      b.range = (from: number, to: number) =>
        Promise.resolve({ data: opts.lineRows.slice(from, to + 1), error: null });
      return b;
    }
    if (table === "pos_line_item_taxes") {
      const b: Record<string, unknown> = {};
      b.delete = () => ({
        in: (_col: string, values: unknown) => {
          recorded.push({ table, op: "delete", filterIn: values });
          return Promise.resolve({ error: opts.deleteError ? { message: opts.deleteError } : null });
        },
      });
      b.insert = (payload: unknown) => {
        recorded.push({ table, op: "insert", payload });
        return Promise.resolve({ error: opts.insertError ? { message: opts.insertError } : null });
      };
      return b;
    }
    throw new Error(`unexpected table: ${table}`);
  };
  return { client: { from } as unknown as SupabaseClient, recorded };
}

const taxOrder: Order = {
  id: "SQ_1",
  location_id: "LOC_1",
  state: "COMPLETED",
  created_at: "2026-07-01T10:00:00Z",
  updated_at: "2026-07-01T10:05:00Z",
  closed_at: "2026-07-01T10:06:00Z",
  taxes: [{ uid: "t1", catalog_object_id: "TAX_GEN", name: "General Sales Tax", percentage: "7.25" }],
  line_items: [
    {
      uid: "LI_1",
      catalog_object_id: "VAR_A",
      quantity: "2",
      name: "Hazy IPA",
      applied_taxes: [{ uid: "at1", tax_uid: "t1", applied_money: { amount: 725, currency: "USD" } }],
    },
  ],
};

describe("backfillLineItemTaxesForRange", () => {
  it("inserts rows for taxed lines", async () => {
    const { client, recorded } = stub({
      orderRows: [{ id: "ODB_1", square_order_id: "SQ_1" }],
      lineRows: [{ id: "LI_DB_1", order_id: "ODB_1", square_line_item_uid: "LI_1" }],
    });
    const fetchOrders = async (ids: string[]) => {
      expect(ids).toEqual(["SQ_1"]);
      return [taxOrder];
    };

    const result = await backfillLineItemTaxesForRange(client, "2026-07-01", "2026-07-02", fetchOrders);

    expect(result).toEqual({ orders: 1, taxRows: 1 });
    const insertCall = recorded.find((r) => r.op === "insert");
    expect(insertCall?.payload).toEqual([
      { line_item_id: "LI_DB_1", square_tax_id: "TAX_GEN", tax_name: "General Sales Tax", tax_pct: 7.25, amount_cents: 725 },
    ]);
  });

  it("deletes existing tax rows for the line before inserting (idempotent)", async () => {
    const { client, recorded } = stub({
      orderRows: [{ id: "ODB_1", square_order_id: "SQ_1" }],
      lineRows: [{ id: "LI_DB_1", order_id: "ODB_1", square_line_item_uid: "LI_1" }],
    });
    const fetchOrders = async () => [taxOrder];

    await backfillLineItemTaxesForRange(client, "2026-07-01", "2026-07-02", fetchOrders);

    const ops = recorded.map((r) => r.op);
    expect(ops.indexOf("delete")).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf("delete")).toBeLessThan(ops.indexOf("insert"));
    expect(recorded.find((r) => r.op === "delete")?.filterIn).toEqual(["LI_DB_1"]);
  });

  it("pages through square_orders and pos_line_items beyond a single page (no 1000-row-cap truncation)", async () => {
    // 3 orders + 3 lines with pageSize=2 forces a second page for BOTH selects.
    const orderRows = [
      { id: "ODB_1", square_order_id: "SQ_1" },
      { id: "ODB_2", square_order_id: "SQ_2" },
      { id: "ODB_3", square_order_id: "SQ_3" },
    ];
    const lineRows = [
      { id: "LI_DB_1", order_id: "ODB_1", square_line_item_uid: "LI_1" },
      { id: "LI_DB_2", order_id: "ODB_2", square_line_item_uid: "LI_1" },
      { id: "LI_DB_3", order_id: "ODB_3", square_line_item_uid: "LI_1" },
    ];
    const { client } = stub({ orderRows, lineRows });
    const fetchedIds: string[] = [];
    const fetchOrders = async (ids: string[]) => {
      fetchedIds.push(...ids);
      return ids.map((id) => ({ ...taxOrder, id }));
    };

    const result = await backfillLineItemTaxesForRange(client, "2026-07-01", "2026-07-02", fetchOrders, 2);

    // All 3 orders were read across the two pages — not just the first page.
    expect([...fetchedIds].sort()).toEqual(["SQ_1", "SQ_2", "SQ_3"]);
    expect(result).toEqual({ orders: 3, taxRows: 3 });
  });

  it("returns zero orders/taxRows and never calls Square when no POS orders exist in range", async () => {
    const { client, recorded } = stub({ orderRows: [], lineRows: [] });
    const fetchOrders = async () => {
      throw new Error("should not be called");
    };

    const result = await backfillLineItemTaxesForRange(client, "2026-07-01", "2026-07-02", fetchOrders);

    expect(result).toEqual({ orders: 0, taxRows: 0 });
    expect(recorded).toEqual([]);
  });

  it("skips an order with no stored line items (nothing to map)", async () => {
    const { client, recorded } = stub({
      orderRows: [{ id: "ODB_1", square_order_id: "SQ_1" }],
      lineRows: [],
    });
    const fetchOrders = async () => [taxOrder];

    const result = await backfillLineItemTaxesForRange(client, "2026-07-01", "2026-07-02", fetchOrders);

    expect(result).toEqual({ orders: 0, taxRows: 0 });
    expect(recorded).toEqual([]);
  });

  it("still clears stale rows (but inserts none) for a line with no applied taxes", async () => {
    const noTaxOrder: Order = {
      ...taxOrder,
      line_items: [{ ...taxOrder.line_items![0], applied_taxes: undefined }],
    };
    const { client, recorded } = stub({
      orderRows: [{ id: "ODB_1", square_order_id: "SQ_1" }],
      lineRows: [{ id: "LI_DB_1", order_id: "ODB_1", square_line_item_uid: "LI_1" }],
    });
    const fetchOrders = async () => [noTaxOrder];

    const result = await backfillLineItemTaxesForRange(client, "2026-07-01", "2026-07-02", fetchOrders);

    expect(result).toEqual({ orders: 1, taxRows: 0 });
    expect(recorded.some((r) => r.op === "delete")).toBe(true);
    expect(recorded.some((r) => r.op === "insert")).toBe(false);
  });

  it("collects an error and continues when the delete fails for one order", async () => {
    const { client, recorded } = stub({
      orderRows: [{ id: "ODB_1", square_order_id: "SQ_1" }],
      lineRows: [{ id: "LI_DB_1", order_id: "ODB_1", square_line_item_uid: "LI_1" }],
      deleteError: "boom",
    });
    const fetchOrders = async () => [taxOrder];

    const result = await backfillLineItemTaxesForRange(client, "2026-07-01", "2026-07-02", fetchOrders);

    expect(result.orders).toBe(0);
    expect(result.taxRows).toBe(0);
    expect(result.errors?.[0]).toContain("boom");
    expect(recorded.some((r) => r.op === "insert")).toBe(false);
  });
});
