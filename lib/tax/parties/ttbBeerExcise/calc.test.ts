/**
 * Covers the TTB compute engine: the shipment-feed read (period vs.
 * calendar-year-to-date split), and the three guards in `computeTtbFigures`
 * that stop this module's simplifying assumptions from failing silently.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaxPeriod } from "@/lib/tax/types";
import { computeTtbFigures, fetchRemovalData } from "./calc";
import { TTB_REDUCED_RATE_MICROS_FALLBACK } from "./rates";

const Q3_2026: TaxPeriod = { start: "2026-07-01", end: "2026-09-30", due: "2026-10-14" };

/** Minimal `export_transactions` stub — records the filter range it was asked for. */
function stubClient(rows: { channel: string; volume_bbl: number; created_at: string }[]) {
  const calls: Record<string, string> = {};
  const builder = {
    select: () => builder,
    gte: (_col: string, value: string) => {
      calls.gte = value;
      return builder;
    },
    lt: (_col: string, value: string) => {
      calls.lt = value;
      return Promise.resolve({ data: rows, error: null });
    },
  };
  const sb = { from: () => builder } as unknown as SupabaseClient;
  return { sb, calls };
}

describe("fetchRemovalData", () => {
  it("splits period barrels from calendar-year-to-date barrels", async () => {
    const { sb } = stubClient([
      { channel: "distribution", volume_bbl: 40, created_at: "2026-05-14T10:00:00Z" }, // Q2 — YTD only
      { channel: "distribution", volume_bbl: 10, created_at: "2026-07-05T10:00:00Z" },
      { channel: "taproom", volume_bbl: 2.5, created_at: "2026-09-30T23:00:00Z" },
    ]);
    const result = await fetchRemovalData(sb, Q3_2026);
    expect(result.barrelsByChannel).toEqual({ distribution: 10, taproom: 2.5 });
    expect(result.barrelsYearToDate).toBe(52.5);
  });

  it("reads from January 1 through the day after the period end", async () => {
    const { sb, calls } = stubClient([]);
    await fetchRemovalData(sb, Q3_2026);
    expect(calls.gte).toBe("2026-01-01T00:00:00Z");
    // Exclusive upper bound at the start of the next day, so the whole of
    // September 30 counts.
    expect(calls.lt).toBe("2026-10-01T00:00:00Z");
  });

  it("names a channel it does not recognize instead of dropping it", async () => {
    const { sb } = stubClient([
      { channel: "distribution", volume_bbl: 10, created_at: "2026-07-05T10:00:00Z" },
      { channel: "festival_donation", volume_bbl: 1, created_at: "2026-07-06T10:00:00Z" },
    ]);
    const result = await fetchRemovalData(sb, Q3_2026);
    expect(result.unknownChannels).toEqual(["festival_donation"]);
  });

  it("counts the wholesale channel as a known removal", async () => {
    const { sb } = stubClient([{ channel: "wholesale", volume_bbl: 5, created_at: "2026-07-05T10:00:00Z" }]);
    const result = await fetchRemovalData(sb, Q3_2026);
    expect(result.unknownChannels).toEqual([]);
    expect(result.barrelsByChannel.wholesale).toBe(5);
  });
});

describe("computeTtbFigures", () => {
  function compute(overrides: Partial<Parameters<typeof computeTtbFigures>[0]> = {}) {
    return computeTtbFigures({
      period: Q3_2026,
      barrelsByChannel: { distribution: 85.42, contract_brewing: 248.63, taproom: 28.45 },
      barrelsYearToDate: 362.5,
      unknownChannels: [],
      rateMicros: TTB_REDUCED_RATE_MICROS_FALLBACK,
      ...overrides,
    });
  }

  it("derives the serial number and period labels from the filing period", () => {
    const { fields } = compute();
    expect(fields.serial_number).toBe("TR-2026-3");
    expect(fields.period_label).toBe("Q3 2026");
    expect(fields.reporting_year).toBe(2026);
    expect(fields.period_start).toBe("2026-07-01");
    expect(fields.period_end).toBe("2026-09-30");
  });

  it("maps channels onto the form and computes the tax", () => {
    const { fields } = compute();
    expect(fields.bbl_total_taxable).toBe(362.5);
    expect(fields.cents_tax_reduced).toBe(126_875); // 362.5 x $3.50
    expect(fields.cents_amount_due).toBe(126_875);
  });

  it("seeds blank Schedule A rows so the grid renders", () => {
    const { fields } = compute();
    expect(fields.sch_a_inc_1_unit).toBe("barrels");
    expect(fields.sch_a_inc_5_quantity).toBe(0);
    expect(fields.sch_a_dec_5_amount_cents).toBe(0);
  });

  it("is quiet on a normal quarter", () => {
    expect(compute().warnings).toBeUndefined();
  });

  it("warns before the reduced-rate ceiling, not after it is crossed", () => {
    const { warnings } = compute({ barrelsYearToDate: 55_000 });
    expect(warnings?.join(" ")).toMatch(/reduced-rate ceiling/);
  });

  it("warns about an unrecognized channel whose barrels are not on line 8", () => {
    const { warnings } = compute({ unknownChannels: ["festival_donation"] });
    expect(warnings?.join(" ")).toMatch(/festival_donation/);
  });

  it("does not warn about carried inventory when the reconciliation closes at zero", () => {
    const { fields, warnings } = compute();
    expect(fields.bbl_ending).toBe(0);
    expect(warnings?.join(" ") ?? "").not.toMatch(/Line 44/);
  });

  it("records where the figures came from", () => {
    expect(compute().meta?.provenance).toBe("export_transactions");
  });
});
