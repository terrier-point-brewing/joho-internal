import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const sumNetPayoutCents = vi.fn();
const resolveConnection = vi.fn();
const recordSyncResult = vi.fn();

vi.mock("@/lib/square/payouts", () => ({
  sumNetPayoutCents: (...a: unknown[]) => sumNetPayoutCents(...a),
}));
vi.mock("../connections", () => ({
  resolveConnection: (...a: unknown[]) => resolveConnection(...a),
  recordSyncResult: (...a: unknown[]) => recordSyncResult(...a),
}));

import { squareBalanceAnchor, squarePayoutsSinceAnchor } from "./squareBalance";
import type { BalanceContext } from "../registry";

/** manual_entries lookup: the latest balance row on or before periodEnd. */
function fakeClient(anchor: { as_of_date: string; amount_cents: number } | null): SupabaseClient {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    lte: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: anchor, error: null }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

function ctx(supabase: SupabaseClient, periodEnd = "2026-07-31"): BalanceContext {
  return { supabase, coaId: "coa-1040", periodEnd, config: { connectionId: "conn-1" } } as BalanceContext;
}

const CONNECTED = { id: "conn-1", provider: "square", label: "Square", credentials: {} };

beforeEach(() => {
  sumNetPayoutCents.mockReset();
  resolveConnection.mockReset();
  recordSyncResult.mockReset();
  resolveConnection.mockResolvedValue(CONNECTED);
  recordSyncResult.mockResolvedValue(undefined);
});

describe("squareBalanceAnchor", () => {
  it("returns the stored cents as-is, already in the internal sign convention", async () => {
    const supabase = fakeClient({ as_of_date: "2026-06-30", amount_cents: 1104175 });
    expect(await squareBalanceAnchor.compute(ctx(supabase))).toBe(1104175);
  });

  it("returns null when the account is not linked to a connection", async () => {
    resolveConnection.mockResolvedValue(null);
    const supabase = fakeClient({ as_of_date: "2026-06-30", amount_cents: 1104175 });
    expect(await squareBalanceAnchor.compute(ctx(supabase))).toBeNull();
  });

  it("returns null when nobody has ever entered a balance, not 0", async () => {
    expect(await squareBalanceAnchor.compute(ctx(fakeClient(null)))).toBeNull();
  });
});

describe("squarePayoutsSinceAnchor", () => {
  it("sums settlements from the anchor date to the period end", async () => {
    sumNetPayoutCents.mockResolvedValue(4268279);
    const supabase = fakeClient({ as_of_date: "2026-06-30", amount_cents: 1104175 });

    expect(await squarePayoutsSinceAnchor.compute(ctx(supabase))).toBe(4268279);
    expect(sumNetPayoutCents).toHaveBeenCalledWith("2026-06-30", "2026-07-31");
  });

  it("carries forward across several months when a close was missed", async () => {
    // A skipped month must not blank the account. Anchoring on the last figure
    // anyone verified and adding every settlement since is more drift but a
    // number with a stated basis.
    sumNetPayoutCents.mockResolvedValue(8010027);
    const supabase = fakeClient({ as_of_date: "2026-05-31", amount_cents: 500000 });

    expect(await squarePayoutsSinceAnchor.compute(ctx(supabase))).toBe(8010027);
    expect(sumNetPayoutCents).toHaveBeenCalledWith("2026-05-31", "2026-07-31");
  });

  it("adds nothing when the anchor IS this period end's verified figure", async () => {
    const supabase = fakeClient({ as_of_date: "2026-07-31", amount_cents: 1104175 });
    expect(await squarePayoutsSinceAnchor.compute(ctx(supabase))).toBe(0);
    expect(sumNetPayoutCents).not.toHaveBeenCalled();
  });

  it("returns 0 for a genuinely quiet window", async () => {
    sumNetPayoutCents.mockResolvedValue(0);
    const supabase = fakeClient({ as_of_date: "2026-06-30", amount_cents: 1104175 });
    expect(await squarePayoutsSinceAnchor.compute(ctx(supabase))).toBe(0);
  });

  it("records a successful read against the connection", async () => {
    sumNetPayoutCents.mockResolvedValue(100);
    await squarePayoutsSinceAnchor.compute(ctx(fakeClient({ as_of_date: "2026-06-30", amount_cents: 1 })));
    expect(recordSyncResult).toHaveBeenCalledWith(expect.anything(), "conn-1", { ok: true });
  });

  it("THROWS on a failed read rather than reporting zero movement", async () => {
    // The single most important behaviour here. Returning 0 or null would let
    // the anchor stand alone and publish a month-old figure as though it were
    // current. Throwing fails the whole method, so the previously stored
    // balance survives -- stale but correct.
    sumNetPayoutCents.mockRejectedValue(new Error("503 upstream"));
    const supabase = fakeClient({ as_of_date: "2026-06-30", amount_cents: 1104175 });

    await expect(squarePayoutsSinceAnchor.compute(ctx(supabase))).rejects.toThrow("Square payouts read failed");
  });

  it("records the failure for the Settings health line", async () => {
    sumNetPayoutCents.mockRejectedValue(new Error("503 upstream"));
    const supabase = fakeClient({ as_of_date: "2026-06-30", amount_cents: 1104175 });

    await expect(squarePayoutsSinceAnchor.compute(ctx(supabase))).rejects.toThrow();
    expect(recordSyncResult).toHaveBeenCalledWith(expect.anything(), "conn-1", {
      ok: false,
      error: "503 upstream",
    });
  });

  it("still surfaces the read failure when recording that failure also fails", async () => {
    sumNetPayoutCents.mockRejectedValue(new Error("503 upstream"));
    recordSyncResult.mockRejectedValue(new Error("db down"));
    const supabase = fakeClient({ as_of_date: "2026-06-30", amount_cents: 1104175 });

    await expect(squarePayoutsSinceAnchor.compute(ctx(supabase))).rejects.toThrow("503 upstream");
  });

  it("returns null, and calls Square not at all, when the account is unlinked", async () => {
    resolveConnection.mockResolvedValue(null);
    const supabase = fakeClient({ as_of_date: "2026-06-30", amount_cents: 1104175 });

    expect(await squarePayoutsSinceAnchor.compute(ctx(supabase))).toBeNull();
    expect(sumNetPayoutCents).not.toHaveBeenCalled();
  });

  it("returns null when there is no anchor to move forward from", async () => {
    expect(await squarePayoutsSinceAnchor.compute(ctx(fakeClient(null)))).toBeNull();
    expect(sumNetPayoutCents).not.toHaveBeenCalled();
  });
});

describe("the two steps go null together", () => {
  // An anchor with no movement, or movement with no anchor, is a half answer --
  // the failure that reported GL 2310 eightfold high. Both must decline, so the
  // account reads as unsourced rather than as a plausible wrong number.
  it("both decline when unlinked", async () => {
    resolveConnection.mockResolvedValue(null);
    const supabase = fakeClient({ as_of_date: "2026-06-30", amount_cents: 1104175 });

    expect(await squareBalanceAnchor.compute(ctx(supabase))).toBeNull();
    expect(await squarePayoutsSinceAnchor.compute(ctx(supabase))).toBeNull();
  });

  it("both decline when there is no anchor", async () => {
    const supabase = fakeClient(null);
    expect(await squareBalanceAnchor.compute(ctx(supabase))).toBeNull();
    expect(await squarePayoutsSinceAnchor.compute(ctx(supabase))).toBeNull();
  });
});
