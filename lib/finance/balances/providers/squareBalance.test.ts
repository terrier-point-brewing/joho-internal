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
const readBankLines = vi.fn();
vi.mock("../bankTransactions", () => ({ readBankLines: (...a: unknown[]) => readBankLines(...a) }));

import { squareBalanceAnchor, squarePayoutsSinceAnchor, squareSweepsSinceAnchor } from "./squareBalance";
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
  readBankLines.mockReset();
  readBankLines.mockResolvedValue(null);
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

/** Verbatim from a real Square ACH credit into the business's bank account. */
const SQUARE_DESCRIPTOR =
  "ORIG CO NAME:Square Inc ORIG ID:9424300002 DESC DATE:260812 CO ENTRY DESCR:SQ260812 " +
  "SEC:PPD TRACE#:021000020275397 EED:260812 IND ID: IND NAME:TERRIER POINT BREWING TRN: 2048611043TC";

const sweep = (amountCents: number) => ({ description: SQUARE_DESCRIPTOR, counterpartyName: null, amountCents });

/** A linked account with an anchor AND a declared sweep destination. */
function sweepCtx(anchorDate = "2026-07-31", periodEnd = "2026-08-31"): BalanceContext {
  return {
    supabase: fakeClient({ as_of_date: anchorDate, amount_cents: 2042913 }),
    coaId: "coa-1040",
    periodEnd,
    config: { connectionId: "conn-1", sweepDestinationCoaId: "coa-1020" },
  } as BalanceContext;
}

describe("squareSweepsSinceAnchor", () => {
  it("returns the bank-recognised transfers as a NEGATIVE contribution", async () => {
    // The bug this whole step exists for: without it the anchor plus a month of
    // payouts reported $38k against a real balance of $8.8k, because the $30k
    // swept to Chase was deducted by nothing.
    readBankLines.mockResolvedValue([sweep(3000000)]);
    expect(await squareSweepsSinceAnchor.compute(sweepCtx())).toBe(-3000000);
  });

  it("reads the same half-open window the payouts step covers", async () => {
    // A sweep dated the anchor day is already inside the anchor figure.
    readBankLines.mockResolvedValue([sweep(3000000)]);
    const context = sweepCtx();
    await squareSweepsSinceAnchor.compute(context);
    expect(readBankLines).toHaveBeenCalledWith(context.supabase, "coa-1020", "2026-07-31", "2026-08-31");
  });

  it("counts name-only matches too, since a dollar that arrived is a dollar that arrived", async () => {
    readBankLines.mockResolvedValue([
      sweep(2745635),
      { description: "ORIG CO NAME:Square Inc", counterpartyName: null, amountCents: 2052729 },
    ]);
    expect(await squareSweepsSinceAnchor.compute(sweepCtx())).toBe(-4798364);
  });

  it("returns a real 0 when the feed was readable and nothing in it was Square", async () => {
    // Distinct from null. The bank WAS checked, so "nothing was swept" is a
    // finding rather than an absence of evidence.
    readBankLines.mockResolvedValue([
      { description: "POS PURCHASE TOWN SQUARE HARDWARE", counterpartyName: null, amountCents: 9999 },
    ]);
    expect(await squareSweepsSinceAnchor.compute(sweepCtx())).toBe(0);
  });

  it("never lets a Square-originated debit ADD to the balance", async () => {
    // A chargeback is not a payout. Negating a negative would credit the Square
    // balance with money that was taken back out of the bank.
    readBankLines.mockResolvedValue([sweep(-50000)]);
    expect(await squareSweepsSinceAnchor.compute(sweepCtx())).toBe(0);
  });

  it("returns null, never 0, when no bank account has been declared", async () => {
    readBankLines.mockResolvedValue([sweep(3000000)]);
    const context = {
      supabase: fakeClient({ as_of_date: "2026-07-31", amount_cents: 2042913 }),
      coaId: "coa-1040",
      periodEnd: "2026-08-31",
      config: { connectionId: "conn-1" },
    } as BalanceContext;
    expect(await squareSweepsSinceAnchor.compute(context)).toBeNull();
    expect(readBankLines).not.toHaveBeenCalled();
  });

  it("returns null, never 0, when there is no feed to read", async () => {
    // readBankLines nulls for no connection, no chosen account, and an empty
    // window alike. Any of them means the account behaves as it did before the
    // bank feed existed rather than claiming nothing was swept.
    readBankLines.mockResolvedValue(null);
    expect(await squareSweepsSinceAnchor.compute(sweepCtx())).toBeNull();
  });

  it("returns null when the account is not linked or has no anchor", async () => {
    readBankLines.mockResolvedValue([sweep(3000000)]);
    resolveConnection.mockResolvedValue(null);
    expect(await squareSweepsSinceAnchor.compute(sweepCtx())).toBeNull();

    resolveConnection.mockResolvedValue(CONNECTED);
    const noAnchor = {
      supabase: fakeClient(null),
      coaId: "coa-1040",
      periodEnd: "2026-08-31",
      config: { connectionId: "conn-1", sweepDestinationCoaId: "coa-1020" },
    } as BalanceContext;
    expect(await squareSweepsSinceAnchor.compute(noAnchor)).toBeNull();
  });

  it("deducts nothing when the anchor IS this period end", async () => {
    // The operator's own figure already reflects every sweep up to that date.
    readBankLines.mockResolvedValue([sweep(3000000)]);
    expect(await squareSweepsSinceAnchor.compute(sweepCtx("2026-08-31", "2026-08-31"))).toBe(0);
    expect(readBankLines).not.toHaveBeenCalled();
  });
});
