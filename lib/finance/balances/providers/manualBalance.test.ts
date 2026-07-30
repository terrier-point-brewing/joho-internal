// Reads an operator-supplied balance from manual_entries (entry_kind =
// 'balance', keyed to chart_of_accounts_id + as_of_date). Absence must
// return null, not 0 -- a later task turns that null into an open
// balance_close_tasks row, and a silent 0 would defeat the close workflow.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { manualBalance } from "./manualBalance";
import type { BalanceContext } from "../registry";

function fakeClient(row: { amount_cents: number | null } | null): SupabaseClient {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

function ctx(supabase: SupabaseClient): BalanceContext {
  return { supabase, coaId: "coa-1", periodEnd: "2026-01-31", config: {} };
}

describe("manualBalance", () => {
  it("returns the stored amount_cents as-is (already internal-convention signed)", async () => {
    const supabase = fakeClient({ amount_cents: -540000 });

    const result = await manualBalance.compute(ctx(supabase));

    expect(result).toBe(-540000);
  });

  it("returns null when no manual entry exists for this account/period, not 0", async () => {
    const supabase = fakeClient(null);

    const result = await manualBalance.compute(ctx(supabase));

    expect(result).toBeNull();
  });

  it("is a manual-kind provider", () => {
    expect(manualBalance.kind).toBe("manual");
  });
});
