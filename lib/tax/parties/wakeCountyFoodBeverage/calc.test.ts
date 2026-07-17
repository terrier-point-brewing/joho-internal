import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComputeContext } from "@/lib/tax/types";
import { computeWakeFigures, computeWakeWorksheet } from "./calc";

describe("computeWakeFigures", () => {
  it("tax owed = round(applicable x rate); no warning when it matches collected", () => {
    const ws = computeWakeFigures({
      grossReceiptsCents: 500000,
      applicableReceiptsCents: 300000,
      collectedFbCents: 3000,
      rate: 0.01,
    });
    expect(ws.fields.wake_gross_receipts_cents).toBe(500000);
    expect(ws.fields.wake_applicable_receipts_cents).toBe(300000);
    expect(ws.fields.wake_tax_owed_cents).toBe(3000); // round(300000 * 0.01)
    expect(ws.fields.wake_rate).toBe(0.01);
    expect(ws.warnings ?? []).toEqual([]);
  });

  it("gross receipts is null when the general sales tax id is unconfigured", () => {
    const ws = computeWakeFigures({
      grossReceiptsCents: null,
      applicableReceiptsCents: 300000,
      collectedFbCents: 3000,
      rate: 0.01,
    });
    expect(ws.fields.wake_gross_receipts_cents).toBeNull();
  });

  it("warns when computed tax diverges from Square-collected beyond tolerance", () => {
    const ws = computeWakeFigures({
      grossReceiptsCents: 500000,
      applicableReceiptsCents: 300000, // -> 3000
      collectedFbCents: 5000,          // diff 2000 >> tolerance
      rate: 0.01,
    });
    expect(ws.warnings?.length).toBe(1);
    expect(ws.warnings?.[0]).toMatch(/differs from Square-collected/);
  });

  it("stays silent within the rounding tolerance (max(100, 0.1% of collected))", () => {
    const ws = computeWakeFigures({
      grossReceiptsCents: null,
      applicableReceiptsCents: 300000, // -> 3000
      collectedFbCents: 3050,          // diff 50 <= 100 tolerance
      rate: 0.01,
    });
    expect(ws.warnings ?? []).toEqual([]);
  });
});

// ── DB glue (stubbed sb) ─────────────────────────────────────────────────────

interface TaxRow {
  line_item_id: string;
  amount_cents: number;
  pos_line_items: { net_sales_cents: number; tax_cents: number };
}

/** Routes pos_line_item_taxes per captured square_tax_id, and tax_rates for getTaxRate. */
function stubSb(opts: { rowsByTaxId: Record<string, TaxRow[]>; rate?: number | null }): SupabaseClient {
  const from = (table: string) => {
    if (table === "tax_rates") {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () =>
        Promise.resolve({ data: opts.rate == null ? null : { rate: opts.rate }, error: null });
      return b;
    }
    if (table !== "pos_line_item_taxes") throw new Error(`unexpected table: ${table}`);
    let taxId = "";
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (_col: string, val: string) => {
      taxId = val;
      return b;
    };
    b.gte = () => b;
    b.lt = () => b;
    b.order = () => b;
    b.range = (fromIdx: number, toIdx: number) =>
      Promise.resolve({ data: (opts.rowsByTaxId[taxId] ?? []).slice(fromIdx, toIdx + 1), error: null });
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

const period = { start: "2026-07-01", end: "2026-07-31", due: "2026-08-20" };

function ctxWith(profile: Record<string, string>): ComputeContext {
  return {
    schedule: {
      id: "s1",
      party_key: "wake_county_food_beverage",
      frequency: "monthly",
      lead_days: 10,
      active: true,
      config: {},
      created_at: "",
      updated_at: "",
    },
    profile,
    period,
  };
}

describe("computeWakeWorksheet", () => {
  it("computes applicable + gross from their own tax ids and the tax_rates rate", async () => {
    const sb = stubSb({
      rowsByTaxId: {
        TAX_FB: [{ line_item_id: "A", amount_cents: 3000, pos_line_items: { net_sales_cents: 303000, tax_cents: 3000 } }],
        TAX_GEN: [{ line_item_id: "A", amount_cents: 23750, pos_line_items: { net_sales_cents: 523750, tax_cents: 23750 } }],
      },
      rate: 0.01,
    });
    const ws = await computeWakeWorksheet(ctxWith({ food_beverage_tax_id: "TAX_FB", general_sales_tax_id: "TAX_GEN" }), sb);
    expect(ws.fields.wake_applicable_receipts_cents).toBe(300000); // 303000 - 3000
    expect(ws.fields.wake_gross_receipts_cents).toBe(500000);      // 523750 - 23750
    expect(ws.fields.wake_tax_owed_cents).toBe(3000);              // round(300000 * 0.01)
    expect(ws.warnings ?? []).toEqual([]);
  });

  it("gross receipts null when general_sales_tax_id is blank", async () => {
    const sb = stubSb({
      rowsByTaxId: { TAX_FB: [{ line_item_id: "A", amount_cents: 3000, pos_line_items: { net_sales_cents: 303000, tax_cents: 3000 } }] },
      rate: 0.01,
    });
    const ws = await computeWakeWorksheet(ctxWith({ food_beverage_tax_id: "TAX_FB" }), sb);
    expect(ws.fields.wake_gross_receipts_cents).toBeNull();
    expect(ws.fields.wake_applicable_receipts_cents).toBe(300000);
  });

  it("falls back to the statutory 1% and warns when no tax_rates row exists", async () => {
    const sb = stubSb({
      rowsByTaxId: { TAX_FB: [{ line_item_id: "A", amount_cents: 3000, pos_line_items: { net_sales_cents: 303000, tax_cents: 3000 } }] },
      rate: null,
    });
    const ws = await computeWakeWorksheet(ctxWith({ food_beverage_tax_id: "TAX_FB" }), sb);
    expect(ws.fields.wake_rate).toBe(0.01);
    expect(ws.warnings?.some((w) => /statutory fallback/.test(w))).toBe(true);
  });

  it("returns only a warning when food_beverage_tax_id is unconfigured", async () => {
    const sb = stubSb({ rowsByTaxId: {}, rate: 0.01 });
    const ws = await computeWakeWorksheet(ctxWith({}), sb);
    expect(ws.fields).toEqual({});
    expect(ws.warnings?.[0]).toMatch(/No Square Prepared Food & Beverage Tax configured/);
  });
});
