import { describe, it, expect, vi, beforeEach } from "vitest";

const sumNetPayoutCents = vi.fn();
vi.mock("@/lib/square/payouts", () => ({ sumNetPayoutCents: (...a: unknown[]) => sumNetPayoutCents(...a) }));

const readBankLines = vi.fn();
vi.mock("./bankTransactions", () => ({ readBankLines: (...a: unknown[]) => readBankLines(...a) }));

import { computeDrift, splitDrift, recordSquareDrift } from "./squareDrift";

/** Verbatim from a real Square ACH credit into the business's bank account. */
const SQUARE_DESCRIPTOR =
  "ORIG CO NAME:Square Inc ORIG ID:9424300002 DESC DATE:260723 CO ENTRY DESCR:SQ260723 " +
  "SEC:PPD TRACE#:021000028611043 EED:260723 IND ID: IND NAME:TERRIER POINT BREWING TRN: 2048611043TC";

const sweep = (amountCents: number) => ({ description: SQUARE_DESCRIPTOR, counterpartyName: null, amountCents });

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

describe("splitDrift", () => {
  it("reconciles a month to exactly zero when the bank saw every dollar leave", () => {
    // The whole point of the feature. Drift is negative because money left
    // Square; the sweep is the same money arriving at the bank, so it is
    // positive, and the two cancel.
    const result = splitDrift(-3900000, [sweep(2745635), sweep(1154365)]);
    expect(result.unexplainedCents).toBe(0);
    expect(result.exactCents).toBe(3900000);
    expect(result.matchedCount).toBe(2);
  });

  it("leaves the part the bank cannot account for", () => {
    const result = splitDrift(-3900000, [sweep(2745635)]);
    expect(result.unexplainedCents).toBe(-1154365);
  });

  it("keeps exact and name-only matches apart while still adding both to the explanation", () => {
    // A dollar that arrived is a dollar that arrived whichever rule found it, so
    // both count toward the explanation -- but a reader deciding how far to
    // trust it needs to see how much rests on prose.
    const result = splitDrift(-4798364, [
      sweep(2745635),
      { description: "ORIG CO NAME:Square Inc", counterpartyName: null, amountCents: 2052729 },
    ]);
    expect(result.exactCents).toBe(2745635);
    expect(result.nameOnlyCents).toBe(2052729);
    expect(result.unexplainedCents).toBe(0);
  });

  it("leaves the whole drift unexplained when a live feed matched nothing", () => {
    // Different from having no feed at all, which never reaches this function.
    // Here the bank WAS checked and had ordinary traffic, so zero explained is a
    // real finding worth recording.
    const result = splitDrift(-3900000, [
      { description: "POS PURCHASE TOWN SQUARE HARDWARE", counterpartyName: null, amountCents: 9999 },
    ]);
    expect(result.unexplainedCents).toBe(-3900000);
    expect(result.matchedCount).toBe(0);
  });

  it("does not let a Square-originated debit reduce the explanation", () => {
    // A chargeback is not a payout. The matcher already ignores it; this pins
    // that the split cannot quietly reintroduce it.
    const result = splitDrift(-100000, [sweep(-50000)]);
    expect(result.unexplainedCents).toBe(-100000);
  });
});

/**
 * The client fake dispatches on TABLE, and within manual_entries on whether the
 * query used `.lt` (the prior anchor) or `.eq` (this period's closing figure).
 */
function fakeClient(opts: {
  closing?: { as_of_date: string; amount_cents: number } | null;
  prior?: { as_of_date: string; amount_cents: number } | null;
  sourceConfig?: Record<string, unknown> | null;
  captureUpsert?: (row: Record<string, unknown>) => void;
}) {
  const manualEntries = () => {
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
    };
    return chain;
  };

  const simple = (result: unknown) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => result,
      upsert: async (row: Record<string, unknown>) => { opts.captureUpsert?.(row); return { error: null }; },
    };
    return chain;
  };

  return {
    from: (table: string) => {
      if (table === "manual_entries") return manualEntries();
      if (table === "balance_sheet_account_sources") {
        return simple({ data: opts.sourceConfig === undefined ? null : { config: opts.sourceConfig }, error: null });
      }
      return simple({ data: null, error: null });
    },
  } as never;
}

beforeEach(() => {
  sumNetPayoutCents.mockReset();
  readBankLines.mockReset();
  readBankLines.mockResolvedValue(null);
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

    expect(result).toMatchObject({ derivedCents: 5372454, driftCents: 1500000 - 5372454 });
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

  it("splits the drift when a destination account is declared and has bank lines", async () => {
    sumNetPayoutCents.mockResolvedValue(4000000);
    readBankLines.mockResolvedValue([sweep(2745635), sweep(1154365)]);

    let written: Record<string, unknown> | undefined;
    const supabase = fakeClient({
      closing: { as_of_date: "2026-07-31", amount_cents: 1100000 },
      prior: { as_of_date: "2026-06-30", amount_cents: 1000000 },
      sourceConfig: { sweepDestinationCoaId: "coa-1020" },
      captureUpsert: (row) => { written = row; },
    });

    const result = await recordSquareDrift(supabase, "coa-1040", "2026-07-31");

    // The bank window matches the payouts window exactly: the prior anchor date
    // is already inside the anchor figure, so it is excluded on the left.
    expect(readBankLines).toHaveBeenCalledWith(supabase, "coa-1020", "2026-06-30", "2026-07-31");
    expect(written).toMatchObject({
      drift_cents: -3900000,
      swept_exact_cents: 3900000,
      swept_name_only_cents: 0,
      swept_match_count: 2,
      unexplained_cents: 0,
    });
    expect(result!.split!.unexplainedCents).toBe(0);
  });

  it("leaves the split columns NULL when no destination account is declared", async () => {
    // Behaviour must be exactly what it was before the bank feed existed: one
    // undifferentiated drift figure.
    sumNetPayoutCents.mockResolvedValue(4000000);
    let written: Record<string, unknown> | undefined;
    const supabase = fakeClient({
      closing: { as_of_date: "2026-07-31", amount_cents: 1100000 },
      prior: { as_of_date: "2026-06-30", amount_cents: 1000000 },
      sourceConfig: {},
      captureUpsert: (row) => { written = row; },
    });

    await recordSquareDrift(supabase, "coa-1040", "2026-07-31");

    expect(readBankLines).not.toHaveBeenCalled();
    expect(written).toMatchObject({
      swept_exact_cents: null,
      swept_name_only_cents: null,
      swept_match_count: null,
      unexplained_cents: null,
    });
  });

  it("leaves the split columns NULL when the destination account has no transactions", async () => {
    // The single most important negative case. A missing feed must never write a
    // zero, because "nothing was swept" and "there was nothing to look at" would
    // then be indistinguishable on the row -- and only one of them is a finding.
    sumNetPayoutCents.mockResolvedValue(4000000);
    readBankLines.mockResolvedValue(null);

    let written: Record<string, unknown> | undefined;
    const supabase = fakeClient({
      closing: { as_of_date: "2026-07-31", amount_cents: 1100000 },
      prior: { as_of_date: "2026-06-30", amount_cents: 1000000 },
      sourceConfig: { sweepDestinationCoaId: "coa-1020" },
      captureUpsert: (row) => { written = row; },
    });

    const result = await recordSquareDrift(supabase, "coa-1040", "2026-07-31");

    expect(written).toMatchObject({ drift_cents: -3900000, unexplained_cents: null, swept_exact_cents: null });
    expect(result!.split).toBeNull();
  });

  it("records a real zero when the bank WAS checked and nothing matched", async () => {
    // The mirror of the case above, and the reason null and zero must differ.
    sumNetPayoutCents.mockResolvedValue(4000000);
    readBankLines.mockResolvedValue([
      { description: "POS PURCHASE TOWN SQUARE HARDWARE", counterpartyName: null, amountCents: 9999 },
    ]);

    let written: Record<string, unknown> | undefined;
    const supabase = fakeClient({
      closing: { as_of_date: "2026-07-31", amount_cents: 1100000 },
      prior: { as_of_date: "2026-06-30", amount_cents: 1000000 },
      sourceConfig: { sweepDestinationCoaId: "coa-1020" },
      captureUpsert: (row) => { written = row; },
    });

    await recordSquareDrift(supabase, "coa-1040", "2026-07-31");

    expect(written).toMatchObject({
      swept_exact_cents: 0,
      swept_match_count: 0,
      unexplained_cents: -3900000,
    });
  });
});
