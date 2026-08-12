import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComputeContext } from "@/lib/tax/types";
import { NC_EXCISE_RATE_MICROS_FALLBACK } from "./rates";
import {
  computeBeerExciseFigures,
  fetchExciseData,
  fetchNcRateMicros,
  computeBeerExciseWorksheet,
  isFiledTimely,
} from "./calc";

const g = { distribution: 1000, contract_brewing: 200, taproom: 300, wholesale: 500 };

describe("isFiledTimely", () => {
  it("is timely at exactly the due date (brewery-local end of day)", () => {
    expect(isFiledTimely("2026-08-15", new Date("2026-08-15T22:00:00Z"))).toBe(true); // 6pm ET, still the 15th
  });
  it("is timely before the due date", () => {
    expect(isFiledTimely("2026-08-15", new Date("2026-08-01T12:00:00Z"))).toBe(true);
  });
  it("is not timely after the due date", () => {
    expect(isFiledTimely("2026-08-15", new Date("2026-08-16T12:00:00Z"))).toBe(false);
  });
});

describe("computeBeerExciseFigures", () => {
  it("maps channel gallons onto the waterfall and taxes only liable channels", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 0, filedTimely: true });
    expect(w.fields.gal_taxable).toBe(1500);
    expect(w.fields.gal_allowable_deductions).toBe(500);
    expect(w.fields.cents_excise_due).toBe(Math.round(1500 * 61.71));
    expect(w.warnings ?? []).toHaveLength(0);
  });
  it("warns on rate drift beyond tolerance", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 80000, missingDetailTxns: 0, filedTimely: true });
    expect(w.warnings?.some((s) => /differs|drift|Review/i.test(s))).toBe(true);
  });
  it("warns when taxable rows are missing NC excise detail", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 3, filedTimely: true });
    expect(w.warnings?.some((s) => /detail|coverage|backfill/i.test(s))).toBe(true);
  });
});

describe("computeBeerExciseFigures — flag_timely driven by filedTimely arg", () => {
  it("sets flag_timely=1 and applies the discount when filedTimely is true", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 0, filedTimely: true });
    expect(w.fields.flag_timely).toBe(1);
    expect(w.fields.cents_discount).toBe(Math.round((w.fields.cents_excise_due as number) * 0.02));
  });
  it("sets flag_timely=0 and no discount when filedTimely is false", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 0, filedTimely: false });
    expect(w.fields.flag_timely).toBe(0);
    expect(w.fields.cents_discount).toBe(0);
  });
  it("never produces flag_amended or flag_no_transactions fields", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 0, filedTimely: true });
    expect(w.fields.flag_amended).toBeUndefined();
    expect(w.fields.flag_no_transactions).toBeUndefined();
  });
});

// ── fetchExciseData (stubbed sb) ──────────────────────────────────────────

interface ExportRow {
  channel: string;
  volume_bbl: number;
  export_transaction_taxes: { tax_name: string; amount_usd: number }[];
  batch_id?: string | null;
  is_phantom?: boolean;
}

function stubSb(rows: ExportRow[], error?: string): SupabaseClient {
  const from = (table: string) => {
    if (table !== "export_transactions") throw new Error(`unexpected table: ${table}`);
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.gte = () => b;
    b.lt = () => b;
    // Paginated read: the error now surfaces from the page fetch, not from lt.
    b.order = () => b;
    b.range = (from: number, to: number) =>
      Promise.resolve({ data: error ? null : rows.slice(from, to + 1), error: error ? { message: error } : null });
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

  // export_transactions.batch_id is nullable — phantom taproom keg-swap rows
  // (is_phantom=true, batch_id=null) booked barrel excise with no cold-storage
  // batch to deduct from, and MUST still be counted here. fetchExciseData's
  // query never selects batch_id or joins brew_batches, so this only needs to
  // prove the row isn't dropped.
  it("includes a phantom (null batch_id, is_phantom=true) row in gallons and stored excise", async () => {
    const rows: ExportRow[] = [
      {
        channel: "taproom",
        volume_bbl: 10,
        export_transaction_taxes: [{ tax_name: "NC Excise Tax", amount_usd: 191.9 }],
        batch_id: null,
        is_phantom: true,
      },
    ];
    const res = await fetchExciseData(stubSb(rows), period);
    expect(res.gallonsByChannel.taproom).toBe(310);
    expect(res.storedNcCents).toBe(Math.round(191.9 * 100));
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
      b.lt = () => b;
      b.order = () => b;
      b.range = () => Promise.resolve({ data: [], error: null });
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
        filing_key: "nc_dor_beer_excise",
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
        filing_key: "nc_dor_beer_excise",
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
        filing_key: "nc_dor_beer_excise",
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

  it("flag_timely is 1 when computed before the period's due date", async () => {
    const ctx: ComputeContext = {
      schedule: { id: "s1", filing_key: "nc_dor_beer_excise", frequency: "monthly", lead_days: 10, active: true, config: {}, created_at: "", updated_at: "" },
      profile: {},
      period,
    };
    const ws = await computeBeerExciseWorksheet(ctx, stubWorksheetSb(), new Date("2026-08-01T12:00:00Z"));
    expect(ws.fields.flag_timely).toBe(1);
  });

  it("flag_timely is 0 when computed after the period's due date", async () => {
    const ctx: ComputeContext = {
      schedule: { id: "s1", filing_key: "nc_dor_beer_excise", frequency: "monthly", lead_days: 10, active: true, config: {}, created_at: "", updated_at: "" },
      profile: {},
      period,
    };
    const ws = await computeBeerExciseWorksheet(ctx, stubWorksheetSb(), new Date("2026-08-20T12:00:00Z"));
    expect(ws.fields.flag_timely).toBe(0);
  });
});
