import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeBeerExciseFigures, fetchExciseData } from "./calc";

describe("computeBeerExciseFigures", () => {
  const g = { distribution: 1000, contract_brewing: 200, taproom: 300, wholesale: 500 };
  it("maps channel gallons onto the waterfall and taxes only liable channels", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 0 });
    expect(w.fields.gal_taxable).toBe(1500);
    expect(w.fields.gal_allowable_deductions).toBe(500);
    expect(w.fields.cents_excise_due).toBe(Math.round(1500 * 61.71));
    expect(w.warnings ?? []).toHaveLength(0);
  });
  it("warns on rate drift beyond tolerance", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 80000, missingDetailTxns: 0 });
    expect(w.warnings?.some((s) => /differs|drift|Review/i.test(s))).toBe(true);
  });
  it("warns when taxable rows are missing NC excise detail", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 3 });
    expect(w.warnings?.some((s) => /detail|coverage|backfill/i.test(s))).toBe(true);
  });
});

// ── fetchExciseData (stubbed sb) ──────────────────────────────────────────

interface ExportRow {
  channel: string;
  volume_bbl: number;
  export_transaction_taxes: { tax_name: string; amount_usd: number }[];
}

function stubSb(rows: ExportRow[], error?: string): SupabaseClient {
  const from = (table: string) => {
    if (table !== "export_transactions") throw new Error(`unexpected table: ${table}`);
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.gte = () => b;
    b.lt = () => Promise.resolve({ data: error ? null : rows, error: error ? { message: error } : null });
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

const period = { start: "2026-07-01", end: "2026-07-31", due: "2026-08-15" };

describe("fetchExciseData", () => {
  it("aggregates gallons by channel and sums NC excise detail on taxable rows", async () => {
    const rows: ExportRow[] = [
      { channel: "taproom", volume_bbl: 10, export_transaction_taxes: [{ tax_name: "NC Excise Tax", amount_usd: 191.9 }] },
    ];
    const res = await fetchExciseData(stubSb(rows), period);
    expect(res.gallonsByChannel.taproom).toBe(310);
    expect(res.storedNcCents).toBe(Math.round(191.9 * 100));
    expect(res.missingDetailTxns).toBe(0);
  });

  it("flags taxable rows with volume but no NC excise detail row", async () => {
    const rows: ExportRow[] = [
      { channel: "distribution", volume_bbl: 5, export_transaction_taxes: [] },
    ];
    const res = await fetchExciseData(stubSb(rows), period);
    expect(res.gallonsByChannel.distribution).toBe(155);
    expect(res.missingDetailTxns).toBe(1);
  });

  it("does not flag missing detail on the non-taxable wholesale channel", async () => {
    const rows: ExportRow[] = [
      { channel: "wholesale", volume_bbl: 5, export_transaction_taxes: [] },
    ];
    const res = await fetchExciseData(stubSb(rows), period);
    expect(res.gallonsByChannel.wholesale).toBe(155);
    expect(res.missingDetailTxns).toBe(0);
  });
});
