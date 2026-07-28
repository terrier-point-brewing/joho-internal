import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchTaxableBase } from "./squareTaxBase";

interface TaxRow {
  line_item_id: string;
  amount_cents: number;
  pos_line_items: {
    net_sales_cents: number;
    tax_cents: number;
    gross_sales_cents: number;
    discount_cents: number;
  };
}

/** Stub Supabase routing `pos_line_item_taxes` via the paged
 * `.select().eq().gte().lt().order().range(from,to)` chain `fetchAllRows` drives. */
function stubSb(rows: TaxRow[], error?: string): SupabaseClient {
  const from = (table: string) => {
    if (table !== "pos_line_item_taxes" && table !== "invoice_line_item_taxes") {
      throw new Error(`unexpected table: ${table}`);
    }
    // The invoice source contributes nothing in these fixtures.
    if (table === "invoice_line_item_taxes") {
      const empty: Record<string, unknown> = {};
      empty.select = () => empty;
      empty.eq = () => empty;
      empty.neq = () => empty;   // the invoice query filters out voided invoices
      empty.gte = () => empty;
      empty.lt = () => empty;
      empty.lte = () => empty;
      empty.order = () => empty;
      empty.range = () => Promise.resolve({ data: [], error: null });
      return empty;
    }
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.gte = () => b;
    b.lt = () => b;
    b.order = () => b;
    b.range = (fromIdx: number, toIdx: number) =>
      Promise.resolve(
        error
          ? { data: null, error: { message: error } }
          : { data: rows.slice(fromIdx, toIdx + 1), error: null },
      );
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

const period = { start: "2026-07-01", end: "2026-07-31", due: "2026-08-20" };

describe("fetchTaxableBase", () => {
  it("sums base (net - tax) and collected (amount), deduping by line_item_id", async () => {
    const rows: TaxRow[] = [
      { line_item_id: "A", amount_cents: 725, pos_line_items: { net_sales_cents: 10000, tax_cents: 725, gross_sales_cents: 9275, discount_cents: 0 } },
      { line_item_id: "B", amount_cents: 363, pos_line_items: { net_sales_cents: 5000, tax_cents: 363, gross_sales_cents: 4637, discount_cents: 0 } },
      { line_item_id: "A", amount_cents: 725, pos_line_items: { net_sales_cents: 10000, tax_cents: 725, gross_sales_cents: 9275, discount_cents: 0 } },
    ];
    const res = await fetchTaxableBase(stubSb(rows), "TAX_FB", period);
    expect(res.baseCents).toBe(10000 - 725 + (5000 - 363));
    expect(res.collectedCents).toBe(725 + 363);
  });

  it("pages through the whole result set — no PostgREST 1000-row truncation", async () => {
    const rows: TaxRow[] = [
      { line_item_id: "A", amount_cents: 100, pos_line_items: { net_sales_cents: 1000, tax_cents: 100, gross_sales_cents: 900, discount_cents: 0 } },
      { line_item_id: "B", amount_cents: 200, pos_line_items: { net_sales_cents: 2000, tax_cents: 200, gross_sales_cents: 1800, discount_cents: 0 } },
      { line_item_id: "C", amount_cents: 300, pos_line_items: { net_sales_cents: 3000, tax_cents: 300, gross_sales_cents: 2700, discount_cents: 0 } },
    ];
    const res = await fetchTaxableBase(stubSb(rows), "TAX_FB", period, 2);
    expect(res.baseCents).toBe(1000 - 100 + (2000 - 200) + (3000 - 300));
    expect(res.collectedCents).toBe(600);
  });

  it("returns zeros when no rows match", async () => {
    const res = await fetchTaxableBase(stubSb([]), "TAX_FB", period);
    expect(res).toEqual({ baseCents: 0, collectedCents: 0 });
  });

  it("throws on query error", async () => {
    await expect(fetchTaxableBase(stubSb([], "boom"), "TAX_FB", period)).rejects.toThrow(/boom/);
  });

  it("unions invoice-collected tax into base and collected", async () => {
    const from = (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b; b.neq = () => b;
      b.gte = () => b; b.lt = () => b; b.lte = () => b; b.order = () => b;
      b.range = (f: number, t: number) => {
        const rows = table === "pos_line_item_taxes"
          ? [{ line_item_id: "P1", amount_cents: 725, pos_line_items: { gross_sales_cents: 9275, discount_cents: 0 } }]
          : [{ line_item_id: "I1", amount_cents: 673, invoice_line_items: { gross_sales_cents: 10000, discount_cents: 724 } }];
        return Promise.resolve({ data: rows.slice(f, t + 1), error: null });
      };
      return b;
    };
    const sb = { from } as unknown as SupabaseClient;
    const res = await fetchTaxableBase(sb, "TAX_GEN", period);
    expect(res.baseCents).toBe(9275 + (10000 - 724));
    expect(res.collectedCents).toBe(725 + 673);
  });

  it("degrades to POS-only when the invoice tax table is missing", async () => {
    const from = (table: string) => {
      if (table === "invoice_line_item_taxes") throw new Error('relation "invoice_line_item_taxes" does not exist');
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b; b.gte = () => b; b.lt = () => b; b.order = () => b;
      b.range = (f: number, t: number) =>
        Promise.resolve({ data: [{ line_item_id: "P1", amount_cents: 725, pos_line_items: { gross_sales_cents: 9275, discount_cents: 0 } }].slice(f, t + 1), error: null });
      return b;
    };
    const sb = { from } as unknown as SupabaseClient;
    const res = await fetchTaxableBase(sb, "TAX_GEN", period);
    expect(res).toEqual({ baseCents: 9275, collectedCents: 725 });
  });

  it("propagates a non-missing-table error from the invoice tax fetch instead of silently zeroing it", async () => {
    const from = (table: string) => {
      if (table === "invoice_line_item_taxes") throw new Error("boom");
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b; b.gte = () => b; b.lt = () => b; b.order = () => b;
      b.range = (f: number, t: number) =>
        Promise.resolve({ data: [{ line_item_id: "P1", amount_cents: 725, pos_line_items: { gross_sales_cents: 9275, discount_cents: 0 } }].slice(f, t + 1), error: null });
      return b;
    };
    const sb = { from } as unknown as SupabaseClient;
    await expect(fetchTaxableBase(sb, "TAX_GEN", period)).rejects.toThrow(/boom/);
  });
});
