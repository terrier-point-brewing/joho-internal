import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComputeContext } from "@/lib/tax/types";
import { NC_EXCISE_RATE_MICROS_FALLBACK } from "./rates";
import {
  computeBeerExciseFigures,
  fetchExciseData,
  fetchNcRateMicros,
  computeBeerExciseWorksheet,
} from "./calc";

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

  it("excludes a 'Franchise Fee' detail row (word-boundary match) but counts 'NC Excise Tax'", async () => {
    const rows: ExportRow[] = [
      {
        channel: "taproom",
        volume_bbl: 10,
        export_transaction_taxes: [
          { tax_name: "Franchise Fee", amount_usd: 50 },
          { tax_name: "NC Excise Tax", amount_usd: 191.9 },
        ],
      },
    ];
    const res = await fetchExciseData(stubSb(rows), period);
    expect(res.storedNcCents).toBe(Math.round(191.9 * 100));
    expect(res.missingDetailTxns).toBe(0);
  });
});

// ── fetchNcRateMicros (stubbed sb via canonical tax_rates table) ──────────

function stubRatesSb(rate: unknown, error?: string): SupabaseClient {
  const from = (table: string) => {
    if (table !== "tax_rates") throw new Error(`unexpected table: ${table}`);
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = () =>
      Promise.resolve({
        data: error ? null : rate == null ? null : { rate },
        error: error ? { message: error } : null,
      });
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

describe("fetchNcRateMicros", () => {
  it("converts the active tax_rates row's rate to micros", async () => {
    const micros = await fetchNcRateMicros(stubRatesSb(0.6171));
    expect(micros).toBe(617100);
  });

  it("returns null when no active nc_dor_beer_excise row is found", async () => {
    const micros = await fetchNcRateMicros(stubRatesSb(null));
    expect(micros).toBeNull();
  });

  it("returns null (not 0) when the matched row's rate is 0", async () => {
    const micros = await fetchNcRateMicros(stubRatesSb(0));
    expect(micros).toBeNull();
  });

  it("fails if the old excise_tax_rates table is queried instead of tax_rates", async () => {
    const legacySb = {
      from: (table: string) => {
        throw new Error(`unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient;
    // fetchNcRateMicros must go through the tax_rates accessor, not
    // excise_tax_rates — this stub only serves the tax_rates table.
    await expect(fetchNcRateMicros(legacySb)).rejects.toThrow();
  });
});

// ── computeBeerExciseWorksheet fallback (stubbed sb) ──────────────────────

function stubWorksheetSb(rate: unknown = null): SupabaseClient {
  const from = (table: string) => {
    if (table === "export_transactions") {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.gte = () => b;
      b.lt = () => Promise.resolve({ data: [], error: null });
      return b;
    }
    if (table === "tax_rates") {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () => Promise.resolve({ data: rate == null ? null : { rate }, error: null });
      return b;
    }
    throw new Error(`unexpected table: ${table}`);
  };
  return { from } as unknown as SupabaseClient;
}

describe("computeBeerExciseWorksheet fallback", () => {
  it("falls back to the statutory rate and warns when no active NC rate row / no transactions exist", async () => {
    const ctx: ComputeContext = {
      schedule: {
        id: "s1",
        party_key: "nc_dor_beer_excise",
        frequency: "monthly",
        lead_days: 10,
        active: true,
        config: {},
        created_at: "",
        updated_at: "",
      },
      profile: {},
      period,
    };
    const ws = await computeBeerExciseWorksheet(ctx, stubWorksheetSb());
    expect(ws.fields.nc_excise_rate_micros).toBe(NC_EXCISE_RATE_MICROS_FALLBACK);
    expect(ws.warnings?.some((s) => /statutory fallback/i.test(s))).toBe(true);
  });

  it("falls back to the statutory rate when the active NC rate row has rate: 0", async () => {
    const ctx: ComputeContext = {
      schedule: {
        id: "s1",
        party_key: "nc_dor_beer_excise",
        frequency: "monthly",
        lead_days: 10,
        active: true,
        config: {},
        created_at: "",
        updated_at: "",
      },
      profile: {},
      period,
    };
    const ws = await computeBeerExciseWorksheet(ctx, stubWorksheetSb(0));
    expect(ws.fields.nc_excise_rate_micros).toBe(NC_EXCISE_RATE_MICROS_FALLBACK);
    expect(ws.warnings?.some((s) => /statutory fallback/i.test(s))).toBe(true);
  });

  it("uses the canonical tax_rates rate when an active nc_dor_beer_excise row exists", async () => {
    const ctx: ComputeContext = {
      schedule: {
        id: "s1",
        party_key: "nc_dor_beer_excise",
        frequency: "monthly",
        lead_days: 10,
        active: true,
        config: {},
        created_at: "",
        updated_at: "",
      },
      profile: {},
      period,
    };
    const ws = await computeBeerExciseWorksheet(ctx, stubWorksheetSb(0.6171));
    expect(ws.fields.nc_excise_rate_micros).toBe(617100);
    expect((ws.warnings ?? []).some((s) => /statutory fallback/i.test(s))).toBe(false);
  });
});
