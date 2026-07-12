import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComputeContext } from "@/lib/tax/types";
import {
  computeNcDorFigures,
  computeDependentTotals,
  fetchTaxableBase,
  computeNcDorWorksheet,
} from "./calc";

const n = (v: number | string | null | undefined) => Number(v ?? 0);

describe("computeNcDorFigures", () => {
  it("single county (Wake, 100%) — full page-1 lines + page-2 county rows, no warning", () => {
    const ws = computeNcDorFigures({
      taxableBaseCents: 100000,
      counties: [{ code: "WAKE", weight: 100 }],
      collectedGeneralTaxCents: 7250,
    });
    const f = ws.fields;
    expect(f.line1_gross_receipts).toBe(100000);
    // State line 4 @ 4.75%
    expect(f.line4_receipts).toBe(100000);
    expect(f.line4_tax).toBe(4750);
    // Wake local 2% -> line 9
    expect(f.line9_receipts).toBe(100000);
    expect(f.line9_tax).toBe(2000);
    // Wake transit 0.5% -> line 11
    expect(f.line11_receipts).toBe(100000);
    expect(f.line11_tax).toBe(500);
    // Totals
    expect(f.line13_total).toBe(7250);
    expect(f.line15_total).toBe(7250);
    expect(f.line21_total_due).toBe(7250);
    // Page-2 county rows
    expect(f.county_WAKE_2pct).toBe(2000);
    expect(f.county_WAKE_225pct).toBe(0);
    expect(f.county_WAKE_transit).toBe(500);
    // Manual defaults
    expect(f.line2_sales_for_resale).toBe(0);
    expect(f.line14_excess).toBe(0);
    expect(f.line20_credit_explanation).toBe("");
    // Reconciles exactly -> no warning
    expect(ws.warnings ?? []).toEqual([]);
  });

  it("two counties (Wake 50 / Durham 50) — routes to distinct local lines, transit lines add", () => {
    const ws = computeNcDorFigures({
      taxableBaseCents: 100000,
      counties: [
        { code: "WAKE", weight: 50 },
        { code: "DURHAM", weight: 50 },
      ],
      collectedGeneralTaxCents: 7375,
    });
    const f = ws.fields;
    // Wake 2% on 50000 -> line 9
    expect(f.line9_receipts).toBe(50000);
    expect(f.line9_tax).toBe(1000);
    // Durham 2.25% on 50000 -> line 10
    expect(f.line10_receipts).toBe(50000);
    expect(f.line10_tax).toBe(1125);
    // Both transit 0.5% -> line 11 adds
    expect(f.line11_tax).toBe(500); // 250 + 250
    expect(f.line11_receipts).toBe(100000); // 50000 + 50000
    // Page-2 county rows
    expect(f.county_WAKE_2pct).toBe(1000);
    expect(f.county_WAKE_transit).toBe(250);
    expect(f.county_DURHAM_225pct).toBe(1125);
    expect(f.county_DURHAM_transit).toBe(250);
    // Sum of county entries = L9 + L10 + L11 + L12
    const countySum =
      n(f.county_WAKE_2pct) +
      n(f.county_WAKE_225pct) +
      n(f.county_WAKE_transit) +
      n(f.county_DURHAM_2pct) +
      n(f.county_DURHAM_225pct) +
      n(f.county_DURHAM_transit);
    expect(countySum).toBe(
      n(f.line9_tax) + n(f.line10_tax) + n(f.line11_tax) + n(f.line12_tax),
    );
    // line13 = state + county + transit
    expect(f.line13_total).toBe(4750 + 1000 + 1125 + 500);
  });

  it("allocates the residual cent so county bases sum exactly to the total base (odd split)", () => {
    // 100001 ¢ across two even weights -> 50000 + 50001 (largest-remainder)
    const ws = computeNcDorFigures({
      taxableBaseCents: 100001,
      counties: [
        { code: "WAKE", weight: 50 },
        { code: "MECKLENBURG", weight: 50 },
      ],
      collectedGeneralTaxCents: 0,
    });
    const f = ws.fields;
    // both are 2% local -> both land on line 9, receipts must sum to full base
    expect(f.line9_receipts).toBe(100001);
    // no base is lost or duplicated
    expect(n(f.line9_receipts)).toBe(100001);
  });

  it("emits a reconciliation warning when collected deviates beyond tolerance", () => {
    const ws = computeNcDorFigures({
      taxableBaseCents: 100000,
      counties: [{ code: "WAKE", weight: 100 }],
      collectedGeneralTaxCents: 7300, // computed 7250, diff 50 >> tolerance
    });
    expect(ws.warnings && ws.warnings.length).toBeGreaterThan(0);
    expect(ws.warnings?.[0]).toMatch(/differs from Square-collected/i);
  });

  it("does NOT warn when collected is within the per-line rounding tolerance", () => {
    const ws = computeNcDorFigures({
      taxableBaseCents: 100000,
      counties: [{ code: "WAKE", weight: 100 }],
      collectedGeneralTaxCents: 7251, // diff 1 <= tolerance
    });
    expect(ws.warnings ?? []).toEqual([]);
  });

  it("warns when configured county weights do not sum to 100", () => {
    const ws = computeNcDorFigures({
      taxableBaseCents: 100000,
      counties: [{ code: "WAKE", weight: 60 }],
      collectedGeneralTaxCents: 7250,
    });
    expect(ws.warnings?.some((w) => /weights/i.test(w))).toBe(true);
  });
});

describe("computeDependentTotals", () => {
  it("flows manual penalty/interest/credit into line21", () => {
    const totals = computeDependentTotals({
      line4_tax: 4750,
      line9_tax: 2000,
      line11_tax: 500,
      line14_excess: 0,
      line16_penalty: 100,
      line17_interest: 25,
      line18_less_prepay: 200,
      line19_prepay_next: 0,
      line20_credit: 50,
    });
    expect(totals.line13_total).toBe(7250);
    expect(totals.line15_total).toBe(7250);
    // 7250 + 100 + 25 - 200 + 0 - 50
    expect(totals.line21_total_due).toBe(7125);
  });
});

// ── fetchTaxableBase / computeNcDorWorksheet DB glue (stubbed sb) ──────────────

interface TaxRow {
  line_item_id: string;
  amount_cents: number;
  pos_line_items: { net_sales_cents: number; tax_cents: number };
}

function stubSb(rows: TaxRow[], error?: string): SupabaseClient {
  const from = (table: string) => {
    if (table !== "pos_line_item_taxes") throw new Error(`unexpected table: ${table}`);
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.gte = () => b;
    b.lt = () => Promise.resolve({ data: error ? null : rows, error: error ? { message: error } : null });
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

const period = { start: "2026-07-01", end: "2026-07-31", due: "2026-08-20" };

describe("fetchTaxableBase", () => {
  it("sums base (net - tax) and collected (amount), deduping by line_item_id", async () => {
    const rows: TaxRow[] = [
      { line_item_id: "A", amount_cents: 725, pos_line_items: { net_sales_cents: 10000, tax_cents: 725 } },
      { line_item_id: "B", amount_cents: 363, pos_line_items: { net_sales_cents: 5000, tax_cents: 363 } },
      // defensive duplicate of A (should be ignored)
      { line_item_id: "A", amount_cents: 725, pos_line_items: { net_sales_cents: 10000, tax_cents: 725 } },
    ];
    const res = await fetchTaxableBase(stubSb(rows), "TAX_GEN", period);
    expect(res.baseCents).toBe(10000 - 725 + (5000 - 363)); // 13912
    expect(res.collectedCents).toBe(725 + 363); // 1088
  });

  it("returns zeros when no rows match", async () => {
    const res = await fetchTaxableBase(stubSb([]), "TAX_GEN", period);
    expect(res).toEqual({ baseCents: 0, collectedCents: 0 });
  });

  it("throws on query error", async () => {
    await expect(fetchTaxableBase(stubSb([], "boom"), "TAX_GEN", period)).rejects.toThrow(/boom/);
  });
});

describe("computeNcDorWorksheet", () => {
  it("reads config counties + general_sales_tax_id, pulls base, computes figures", async () => {
    // one line: net 107250, tax 7250 -> base 100000, collected 7250
    const rows: TaxRow[] = [
      { line_item_id: "A", amount_cents: 7250, pos_line_items: { net_sales_cents: 107250, tax_cents: 7250 } },
    ];
    const ctx: ComputeContext = {
      schedule: {
        id: "s1",
        party_key: "nc_dor_sales_use",
        frequency: "monthly",
        lead_days: 10,
        active: true,
        config: { counties: [{ code: "WAKE", weight: 100 }] },
        created_at: "",
        updated_at: "",
      },
      profile: { general_sales_tax_id: "TAX_GEN" },
      period,
    };
    const ws = await computeNcDorWorksheet(ctx, stubSb(rows));
    expect(ws.fields.line1_gross_receipts).toBe(100000);
    expect(ws.fields.line4_tax).toBe(4750);
    expect(ws.fields.line9_tax).toBe(2000);
    expect(ws.fields.line11_tax).toBe(500);
    expect(ws.fields.line13_total).toBe(7250);
    expect(ws.warnings ?? []).toEqual([]);
    expect(ws.meta?.provenance).toBe("square");
  });
});
