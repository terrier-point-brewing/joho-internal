import { describe, it, expect, vi, beforeEach } from "vitest";

const sumNetPayoutCents = vi.fn();
vi.mock("@/lib/square/payouts", () => ({ sumNetPayoutCents: (...a: unknown[]) => sumNetPayoutCents(...a) }));

import { computeDrift, recordSquareDrift } from "./squareDrift";

describe("computeDrift", () => {
  it("derives anchor plus settlements", () => {
    expect(computeDrift({ anchorCents: 1104175, payoutsCents: 4268279, actualCents: 0 }).derivedCents).toBe(5372454);
  });

  it("reports a shortfall as NEGATIVE drift, the expected direction", () => {
    // Money left the Square balance without appearing in any feed -- an
    // ordinary sweep to the bank. This is what a healthy month looks like.
    const { driftCents } = computeDrift({ anchorCents: 1000000, payoutsCents: 4000000, actualCents: 1100000 });
    expect(driftCents).toBe(-3900000);
  });

  it("reports unexplained money arriving as POSITIVE drift", () => {
    const { driftCents } = computeDrift({ anchorCents: 1000000, payoutsCents: 100000, actualCents: 1200000 });
    expect(driftCents).toBe(100000);
  });

  it("reports zero drift when the derivation was exactly right", () => {
    expect(computeDrift({ anchorCents: 500, payoutsCents: 250, actualCents: 750 }).driftCents).toBe(0);
  });
});

/**
 * manual_entries is queried twice: once with .eq for the closing figure, once
 * with .lt for the prior anchor. This fake dispatches on which was used.
 */
function fakeClient(opts: {
  closing?: { as_of_date: string; amount_cents: number } | null;
  prior?: { as_of_date: string; amount_cents: number } | null;
  captureUpsert?: (row: Record<string, unknown>) => void;
}) {
  const makeChain = () => {
    let usedLt = false;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      lt: () => { usedLt = true; return chain; },
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({
        data: usedLt ? (opts.prior ?? null) : (opts.closing ?? null),
        error: null,
      }),
      upsert: async (row: Record<string, unknown>) => { opts.captureUpsert?.(row); return { error: null }; },
    };
    return chain;
  };
  return { from: () => makeChain() } as never;
}

beforeEach(() => {
  sumNetPayoutCents.mockReset();
});

describe("recordSquareDrift", () => {
  it("records the drift once the month has been re-anchored", async () => {
    sumNetPayoutCents.mockResolvedValue(4268279);
    let written: Record<string, unknown> | undefined;
    const supabase = fakeClient({
      closing: { as_of_date: "2026-07-31", amount_cents: 1500000 },
      prior: { as_of_date: "2026-06-30", amount_cents: 1104175 },
      captureUpsert: (row) => { written = row; },
    });

    const result = await recordSquareDrift(supabase, "coa-1040", "2026-07-31");

    expect(result).toEqual({ derivedCents: 5372454, driftCents: 1500000 - 5372454 });
    expect(written).toMatchObject({
      period_end: "2026-07-31",
      anchor_date: "2026-06-30",
      anchor_cents: 1104175,
      payouts_cents: 4268279,
      derived_cents: 5372454,
      actual_cents: 1500000,
    });
    expect(sumNetPayoutCents).toHaveBeenCalledWith("2026-06-30", "2026-07-31");
  });

  it("does nothing when the month has not been closed yet", async () => {
    const supabase = fakeClient({ closing: null, prior: { as_of_date: "2026-06-30", amount_cents: 1 } });
    expect(await recordSquareDrift(supabase, "coa-1040", "2026-07-31")).toBeNull();
    expect(sumNetPayoutCents).not.toHaveBeenCalled();
  });

  it("does nothing for the very first anchor, which corrects no prior derivation", async () => {
    const supabase = fakeClient({ closing: { as_of_date: "2026-07-31", amount_cents: 1104175 }, prior: null });
    expect(await recordSquareDrift(supabase, "coa-1040", "2026-07-31")).toBeNull();
    expect(sumNetPayoutCents).not.toHaveBeenCalled();
  });
});
