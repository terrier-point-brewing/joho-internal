import { describe, it, expect, vi, afterEach } from "vitest";
import { plaidBalance } from "./plaidBalance";
import type { BalanceContext } from "../registry";
import type { CoaAccountRef } from "../../financials/types";

/**
 * Two tables are read in sequence -- integration_connections (via
 * resolveConnection) then gl_account_daily_balances -- so the stub answers per
 * table rather than with a single canned result.
 */
function stubClient(byTable: Record<string, { data?: unknown; error?: { message: string } | null }>) {
  const queried: { table: string; filters: [string, unknown][] }[] = [];

  const client = {
    from: (table: string) => {
      const entry = { table, filters: [] as [string, unknown][] };
      queried.push(entry);
      const result = byTable[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          entry.filters.push([col, val]);
          return builder;
        },
        maybeSingle: async () => {
          if (result.error && table === "integration_connections") throw new Error(result.error.message);
          return result;
        },
      });
      return builder;
    },
  };

  return { client: client as unknown as BalanceContext["supabase"], queried };
}

function ctx(over: Partial<BalanceContext> = {}): BalanceContext {
  const { client } = stubClient({});
  return {
    supabase: client,
    periodEnd: "2026-07-31",
    coaId: "coa-1020",
    config: { connectionId: "conn-1" },
    ...over,
  };
}

const CONNECTION_ROW = {
  id: "conn-1",
  provider: "plaid",
  label: "Chase · Operating",
  external_id: "plaid-account-1",
  config: {},
  status: "active",
  last_synced_at: null,
  last_error: null,
  credentials: { access_token: "access-live" },
};

afterEach(() => vi.restoreAllMocks());

describe("plaidBalance registration", () => {
  it("is offerable on a bank account and nowhere else", () => {
    const applies = (section: string) => plaidBalance.appliesTo!({ statementSection: section } as CoaAccountRef);
    expect(applies("bank")).toBe(true);
    expect(applies("other_current_liabilities")).toBe(false);
    expect(applies("equity")).toBe(false);
  });

  it("declares itself an integration", () => {
    expect(plaidBalance.kind).toBe("integration");
  });
});

describe("plaidBalance.compute", () => {
  it("returns the balance captured on the period end", async () => {
    const { client } = stubClient({
      integration_connections: { data: CONNECTION_ROW, error: null },
      gl_account_daily_balances: { data: { balance_cents: 4_812_355 }, error: null },
    });
    expect(await plaidBalance.compute(ctx({ supabase: client }))).toBe(4_812_355);
  });

  it("reads the period end, never today", async () => {
    // The whole point of the capture table: a snapshot of 31 July must look up
    // 31 July, not whatever day the cron happens to run.
    const { client, queried } = stubClient({
      integration_connections: { data: CONNECTION_ROW, error: null },
      gl_account_daily_balances: { data: { balance_cents: 1 }, error: null },
    });
    await plaidBalance.compute(ctx({ supabase: client, periodEnd: "2026-06-30" }));

    const daily = queried.find((q) => q.table === "gl_account_daily_balances")!;
    expect(daily.filters).toContainEqual(["as_of_date", "2026-06-30"]);
    expect(daily.filters).toContainEqual(["chart_of_accounts_id", "coa-1020"]);
  });

  it("returns null without touching the capture table when no bank is linked", async () => {
    const { client, queried } = stubClient({});
    expect(await plaidBalance.compute(ctx({ supabase: client, config: {} }))).toBeNull();
    expect(queried).toEqual([]);
  });

  it("returns null for a dangling connection id", async () => {
    const { client } = stubClient({ integration_connections: { data: null, error: null } });
    expect(await plaidBalance.compute(ctx({ supabase: client }))).toBeNull();
  });

  it("returns null when nothing was captured that day, never an older figure", async () => {
    // A missing capture must surface as a missing balance. Presenting the
    // nearest earlier reading as a month-end figure would be undetectable.
    const { client } = stubClient({
      integration_connections: { data: CONNECTION_ROW, error: null },
      gl_account_daily_balances: { data: null, error: null },
    });
    expect(await plaidBalance.compute(ctx({ supabase: client }))).toBeNull();
  });

  it("keeps a genuine zero balance rather than reporting it as unsourced", async () => {
    const { client } = stubClient({
      integration_connections: { data: CONNECTION_ROW, error: null },
      gl_account_daily_balances: { data: { balance_cents: 0 }, error: null },
    });
    expect(await plaidBalance.compute(ctx({ supabase: client }))).toBe(0);
  });

  it("passes an overdrawn balance through unchanged", async () => {
    const { client } = stubClient({
      integration_connections: { data: CONNECTION_ROW, error: null },
      gl_account_daily_balances: { data: { balance_cents: -125_000 }, error: null },
    });
    expect(await plaidBalance.compute(ctx({ supabase: client }))).toBe(-125_000);
  });

  it("degrades to null instead of throwing when the connection store is unreachable", async () => {
    // Graceful degradation: an unreachable table must leave the balance sheet
    // rendering, and a null write leaves any stored month-end row untouched.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = stubClient({
      integration_connections: { data: null, error: { message: "relation does not exist" } },
    });
    await expect(plaidBalance.compute(ctx({ supabase: client }))).resolves.toBeNull();
  });

  it("never reads the live bank API during a snapshot", async () => {
    // compute() answers for a past month end. Plaid can only answer for right
    // now, so any fetch here would be storing today's balance as July's.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { client } = stubClient({
      integration_connections: { data: CONNECTION_ROW, error: null },
      gl_account_daily_balances: { data: { balance_cents: 100 }, error: null },
    });
    await plaidBalance.compute(ctx({ supabase: client }));
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
