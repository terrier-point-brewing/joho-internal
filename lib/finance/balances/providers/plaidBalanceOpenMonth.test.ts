/**
 * GL 1020 during the OPEN month.
 *
 * The balance sheet live-computes the current month by asking every provider
 * for that month's LAST day, so on 12 August it asks for 31 August. Nothing has
 * captured that date and nothing could, so an exact-date lookup returned null
 * and the account read as unsourced from the 1st until the close -- which is
 * most of the time anyone actually looks at the statement. Kept separate from
 * plaidBalance.test.ts, which covers the closed-month path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/utils/datetime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils/datetime")>()),
  todayLocalDate: () => "2026-08-12",
}));

import { plaidBalance } from "./plaidBalance";
import type { BalanceContext } from "../registry";

const CONNECTION = {
  id: "conn-1",
  provider: "plaid",
  label: "Chase · Operating",
  external_id: "acct-1",
  config: {},
  status: "active",
  last_synced_at: null,
  last_error: null,
  credentials: {},
};

/** Records the filters applied to gl_account_daily_balances so date bounds can be asserted. */
function stubClient(dailyRow: { balance_cents: number } | null) {
  const filters: [string, unknown][] = [];

  const client = {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          if (table === "gl_account_daily_balances") filters.push(["eq:" + col, val]);
          return builder;
        },
        lte: (col: string, val: unknown) => {
          filters.push(["lte:" + col, val]);
          return builder;
        },
        gte: (col: string, val: unknown) => {
          filters.push(["gte:" + col, val]);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () =>
          table === "integration_connections"
            ? { data: CONNECTION, error: null }
            : { data: dailyRow, error: null },
      });
      return builder;
    },
  };

  return { client: client as unknown as BalanceContext["supabase"], filters };
}

function ctx(periodEnd: string, dailyRow: { balance_cents: number } | null) {
  const { client, filters } = stubClient(dailyRow);
  return {
    context: { supabase: client, coaId: "coa-1020", periodEnd, config: { connectionId: "conn-1" } },
    filters,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("plaidBalance during the open month", () => {
  it("reports the newest capture instead of nothing", async () => {
    const { context } = ctx("2026-08-31", { balance_cents: 812_44 });

    // Before this, GL 1020 was blank on screen for the whole month.
    expect(await plaidBalance.compute(context)).toBe(812_44);
  });

  it("looks back from today, not from the month end, and bounds how stale it may be", async () => {
    const { context, filters } = ctx("2026-08-31", { balance_cents: 1 });

    await plaidBalance.compute(context);

    // Never asks for a date beyond today...
    expect(filters).toContainEqual(["lte:as_of_date", "2026-08-12"]);
    // ...and refuses a capture older than the running-balance window, so a feed
    // that stopped weeks ago stops reporting rather than publishing a stale
    // figure as the current balance.
    expect(filters).toContainEqual(["gte:as_of_date", "2026-08-05"]);
  });

  it("returns null when every recent capture is too old", async () => {
    const { context } = ctx("2026-08-31", null);

    // Unsourced is visibly wrong; a three-week-old balance labelled "current"
    // is plausibly wrong, which is worse.
    expect(await plaidBalance.compute(context)).toBeNull();
  });
});

describe("plaidBalance for a closed month", () => {
  it("still demands the exact month-end capture", async () => {
    const { context, filters } = ctx("2026-07-31", { balance_cents: 500_00 });

    expect(await plaidBalance.compute(context)).toBe(500_00);
    // Exact-date lookup: an equality on the period end, never a range. This
    // figure gets frozen into the close.
    expect(filters).toContainEqual(["eq:as_of_date", "2026-07-31"]);
    expect(filters.some(([k]) => k.startsWith("lte:"))).toBe(false);
  });

  it("treats a period end falling on today as closed", async () => {
    const { context, filters } = ctx("2026-08-12", { balance_cents: 1 });

    await plaidBalance.compute(context);

    expect(filters).toContainEqual(["eq:as_of_date", "2026-08-12"]);
  });
});
