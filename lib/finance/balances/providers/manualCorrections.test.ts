import { describe, it, expect } from "vitest";
import { manualCorrections } from "./manualCorrections";
import type { BalanceContext } from "../registry";

/**
 * Minimal manual_entries stub. Records the filters applied so the test can
 * assert this provider reads ONLY hand-typed entries -- reading a feed table
 * would reintroduce the double-count this provider exists to avoid.
 */
function stubSupabase(rows: unknown[], seen: { table?: string; filters: Record<string, unknown> }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  Object.assign(builder, {
    select: chain,
    eq: (col: string, val: unknown) => { seen.filters[col] = val; return builder; },
    lte: (col: string, val: unknown) => { seen.filters[col] = val; return builder; },
    order: chain,
    // fetchAllRows paginates with .range(); the fake slices so a single page
    // terminates the loop the way a short page does in production.
    range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
  });
  return {
    from: (table: string) => { seen.table = table; return builder; },
  } as unknown as BalanceContext["supabase"];
}

function ctx(supabase: BalanceContext["supabase"], periodEnd = "2026-05-31"): BalanceContext {
  return { supabase, periodEnd, coaId: "coa-2410", config: {} };
}

describe("manualCorrections", () => {
  it("returns null when nobody has typed a correction", async () => {
    // Null, never 0. A zero would claim the operator entered a correction that
    // came to nothing, and on a method where this is the only contributing step
    // it would turn an unsourced account into a confident $0.
    const seen: { table?: string; filters: Record<string, unknown> } = { filters: {} };
    expect(await manualCorrections.compute(ctx(stubSupabase([], seen)))).toBeNull();
  });

  it("reads only hand-typed movements, never a feed table", async () => {
    const seen: { table?: string; filters: Record<string, unknown> } = { filters: {} };
    await manualCorrections.compute(ctx(stubSupabase([], seen)));

    expect(seen.table).toBe("manual_entries");
    // "flow" and not "balance": a flow entry is a movement that composes, which
    // is what a correction on an accumulating account is. A balance entry states
    // a whole position and is handled by the stated-balance override instead.
    expect(seen.filters.entry_kind).toBe("flow");
    expect(seen.filters.chart_of_accounts_id).toBe("coa-2410");
  });

  it("sums a correction through the period end", async () => {
    const seen: { table?: string; filters: Record<string, unknown> } = { filters: {} };
    const rows = [{ id: "e1", start_date: "2026-05-01", end_date: "2026-05-31", amount_cents: -250_000 }];
    expect(await manualCorrections.compute(ctx(stubSupabase(rows, seen)))).toBe(-250_000);
  });

  it("keeps a correction in force in later months", async () => {
    // The whole reason a correction on an accumulating account only needs
    // entering once: the sum runs from inception, so May's entry is still in
    // July's figure without anybody retyping it.
    const seen: { table?: string; filters: Record<string, unknown> } = { filters: {} };
    const rows = [{ id: "e1", start_date: "2026-05-01", end_date: "2026-05-31", amount_cents: -250_000 }];
    const july = await manualCorrections.compute(ctx(stubSupabase(rows, seen), "2026-07-31"));
    expect(july).toBe(-250_000);
  });

  it("passes the stored sign through unchanged", async () => {
    // amount_cents is already in the internal convention, where a liability is
    // negative. Re-normalising here would flip a credit-side correction.
    const seen: { table?: string; filters: Record<string, unknown> } = { filters: {} };
    const rows = [{ id: "e1", start_date: "2026-05-01", end_date: "2026-05-31", amount_cents: 120_000 }];
    expect(await manualCorrections.compute(ctx(stubSupabase(rows, seen)))).toBe(120_000);
  });

  it("returns 0, not null, when entries exist and cancel out", async () => {
    // A real answer: somebody entered a correction and its reversal, and the
    // account is genuinely unmoved. Distinct from having no entries at all.
    const seen: { table?: string; filters: Record<string, unknown> } = { filters: {} };
    const rows = [
      { id: "e1", start_date: "2026-05-01", end_date: "2026-05-31", amount_cents: 100_000 },
      { id: "e2", start_date: "2026-05-01", end_date: "2026-05-31", amount_cents: -100_000 },
    ];
    expect(await manualCorrections.compute(ctx(stubSupabase(rows, seen)))).toBe(0);
  });

  it("ignores an entry with no usable dates rather than counting it as zero", async () => {
    const seen: { table?: string; filters: Record<string, unknown> } = { filters: {} };
    const rows = [{ id: "e1", start_date: null, end_date: null, amount_cents: 500 }];
    expect(await manualCorrections.compute(ctx(stubSupabase(rows, seen)))).toBeNull();
  });
});
