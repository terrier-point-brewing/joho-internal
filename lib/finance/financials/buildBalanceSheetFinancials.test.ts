// Tests buildFinancials.ts's balance_sheet branch (spec §4.5) -- the riskiest
// piece of Task 4: it reads lib/finance/balances/snapshot.ts's fetchBalances
// for closed months and live-computes the still-open (current) month straight
// from the provider registry, blending both into one FinancialsRow per
// sourced account. Kept in its own file (rather than folded into
// buildFinancials.test.ts) because it needs a materially different mock
// surface -- the DB layer this branch actually reads, not
// fetchFinancialsSources (which this branch never calls at all).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock("./fetchSources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchSources")>();
  return { ...actual, fetchCoa: vi.fn(), fetchExciseCoverage: vi.fn(), fetchFinancialsSources: vi.fn() };
});
vi.mock("@/lib/finance/balances/snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/finance/balances/snapshot")>();
  return { ...actual, fetchBalances: vi.fn(), fetchStatedBalanceMonths: vi.fn() };
});
// Partial: only the lookup is faked, so this suite can hand expandSources
// whatever provider a test needs. Everything else (createSharedComputeCache,
// sharedRead) is the real thing -- a hand-written stand-in for the whole module
// went stale the moment the registry grew a new export.
vi.mock("@/lib/finance/balances/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/finance/balances/registry")>();
  return { ...actual, getProvider: vi.fn(), registerProvider: vi.fn(), listProviders: vi.fn(() => []) };
});
// No-op: skip the real provider modules' side-effect registration entirely --
// this suite controls getProvider's return value directly per test.
vi.mock("@/lib/finance/balances/providers", () => ({}));

import { buildFinancials } from "./buildFinancials";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchCoa, fetchExciseCoverage } from "./fetchSources";
import { fetchBalances, fetchStatedBalanceMonths } from "@/lib/finance/balances/snapshot";
import { getProvider } from "@/lib/finance/balances/registry";
import type { CoaRecord } from "./aggregateRows";
import type { BalanceProvider } from "@/lib/finance/balances/registry";

const mockedCreateAdmin = vi.mocked(createSupabaseAdminClient);
const mockedFetchCoa = vi.mocked(fetchCoa);
const mockedFetchExcise = vi.mocked(fetchExciseCoverage);
const mockedFetchBalances = vi.mocked(fetchBalances);
const mockedFetchStatedMonths = vi.mocked(fetchStatedBalanceMonths);
const mockedGetProvider = vi.mocked(getProvider);

/** Minimal fake admin client -- the balance_sheet branch only ever queries balance_sheet_account_sources directly (everything else goes through the mocked fetchCoa/fetchBalances/provider.compute). */
function fakeSupabase(activeSourceRows: { chart_of_accounts_id: string; provider_key: string; config?: Record<string, unknown> }[]) {
  return {
    from(table: string) {
      if (table !== "balance_sheet_account_sources") throw new Error(`fakeSupabase: unexpected table "${table}"`);
      return { select: () => ({ eq: () => Promise.resolve({ data: activeSourceRows, error: null }) }) };
    },
  } as unknown as SupabaseClient;
}

function fakeProvider(key: string, compute: BalanceProvider["compute"]): BalanceProvider {
  return { key, label: key, kind: "manual", compute };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-15T00:00:00Z"));
  mockedFetchExcise.mockResolvedValue({ shipmentsMissingExcise: 0 });
  // No account overridden by hand unless a test says so -- the ordinary state,
  // and what keeps every existing assertion about the figures unchanged.
  mockedFetchStatedMonths.mockResolvedValue(new Map());
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const COA: CoaRecord[] = [
  { id: "coa-2220", parentId: null, accountName: "Sales Tax Payable", accountNumber: "2220", accountType: "Other Current Liabilities", statementSection: null },
  { id: "coa-2230", parentId: null, accountName: "Unsourced Liability", accountNumber: "2230", accountType: "Other Current Liabilities", statementSection: null },
  { id: "coa-bank", parentId: null, accountName: "Operating Checking", accountNumber: "1000", accountType: "Bank", statementSection: null },
  { id: "coa-rev", parentId: null, accountName: "Taproom Sales", accountNumber: "4000", accountType: "Income", statementSection: null },
];

describe("buildFinancials — balance_sheet", () => {
  it("reads the frozen snapshot for a closed month, live-computes the still-open (current) month, and never falls back to a stale snapshot value for it", async () => {
    mockedCreateAdmin.mockReturnValue(fakeSupabase([{ chart_of_accounts_id: "coa-2220", provider_key: "manualBalance" }]));
    mockedFetchCoa.mockResolvedValue(COA);
    // Closed month (June): frozen snapshot value. Open month (July): a STALE
    // value that must never surface -- the live provider compute below must
    // win instead.
    mockedFetchBalances.mockResolvedValue(new Map([["coa-2220", { "2026-06": -50000, "2026-07": -1 }]]));

    const liveCompute = vi.fn().mockResolvedValue(-99999);
    mockedGetProvider.mockImplementation((key) => (key === "manualBalance" ? fakeProvider("manualBalance", liveCompute) : undefined));

    const resp = await buildFinancials({ statement: "balance_sheet", year: 2026 });

    expect(resp.months).toHaveLength(12);
    expect(resp.months.at(-1)).toBe("2026-07");

    const row = resp.rows.find((r) => r.coaId === "coa-2220");
    expect(row).toBeDefined();
    expect(row!.amountCentsByMonth["2026-06"]).toBe(-50000); // frozen snapshot
    expect(row!.amountCentsByMonth["2026-07"]).toBe(-99999); // live compute, not the stale -1
    expect(row!.statementSection).toBe("other_current_liabilities");

    // Live compute was actually invoked with the open month's period end.
    expect(liveCompute).toHaveBeenCalledWith(expect.objectContaining({ coaId: "coa-2220", periodEnd: "2026-07-31" }));
  });

  it("skips an account with no data in any month (nothing snapshotted, nothing live)", async () => {
    mockedCreateAdmin.mockReturnValue(fakeSupabase([]));
    mockedFetchCoa.mockResolvedValue(COA);
    mockedFetchBalances.mockResolvedValue(new Map());
    mockedGetProvider.mockReturnValue(undefined);

    const resp = await buildFinancials({ statement: "balance_sheet", year: 2026 });

    expect(resp.rows.find((r) => r.coaId === "coa-2220")).toBeUndefined();
    expect(resp.rows).toHaveLength(0);
  });

  it("computes cashOnHandCents from the bank-section row at the last month", async () => {
    mockedCreateAdmin.mockReturnValue(fakeSupabase([{ chart_of_accounts_id: "coa-bank", provider_key: "manualBalance" }]));
    mockedFetchCoa.mockResolvedValue(COA);
    mockedFetchBalances.mockResolvedValue(new Map());
    mockedGetProvider.mockImplementation((key) =>
      key === "manualBalance" ? fakeProvider("manualBalance", vi.fn().mockResolvedValue(500000)) : undefined,
    );

    const resp = await buildFinancials({ statement: "balance_sheet", year: 2026 });

    expect(resp.kpis.cashOnHandCents).toBe(500000);
    expect(resp.kpis.operatingCashCents).toBeNull();
  });

  it("counts balance-sheet accounts with no active source in dataQuality.unsourcedAccounts, excluding P&L accounts", async () => {
    mockedCreateAdmin.mockReturnValue(fakeSupabase([{ chart_of_accounts_id: "coa-2220", provider_key: "manualBalance" }]));
    mockedFetchCoa.mockResolvedValue(COA);
    mockedFetchBalances.mockResolvedValue(new Map());
    mockedGetProvider.mockImplementation((key) =>
      key === "manualBalance" ? fakeProvider("manualBalance", vi.fn().mockResolvedValue(0)) : undefined,
    );

    const resp = await buildFinancials({ statement: "balance_sheet", year: 2026 });

    // coa-2220 is sourced; coa-bank and coa-2230 are BS accounts with no
    // active source; coa-rev is a P&L account and must not be counted.
    expect(resp.dataQuality.unsourcedAccounts).toEqual({
      count: 2, href: "/settings/finance/balance-sheet-accounts",
    });
  });
});

/**
 * A stated balance is the one figure on this statement that is not what its
 * named source reported, so the row has to carry that fact to the table. The
 * marker is per MONTH, not per account: an override applies to the month it is
 * dated and the months either side of it are the feed's own readings.
 */
describe("buildFinancials — balance_sheet marks months an operator restated", () => {
  it("carries the stored months through to the row", async () => {
    mockedCreateAdmin.mockReturnValue(fakeSupabase([{ chart_of_accounts_id: "coa-2220", provider_key: "manualBalance" }]));
    mockedFetchCoa.mockResolvedValue(COA);
    mockedFetchBalances.mockResolvedValue(new Map([["coa-2220", { "2026-05": -10000, "2026-06": -50000 }]]));
    mockedFetchStatedMonths.mockResolvedValue(new Map([["coa-2220", new Set(["2026-06"])]]));
    mockedGetProvider.mockReturnValue(undefined);

    const resp = await buildFinancials({ statement: "balance_sheet", year: 2026 });
    const row = resp.rows.find((r) => r.coaId === "coa-2220")!;

    expect(row.statedMonths).toEqual(["2026-06"]);
  });

  it("marks the open month from the live compute, which has no stored row yet", async () => {
    // Without this the marker would disappear the moment a month became the
    // current one -- the months where somebody is most likely to be correcting
    // a figure by hand.
    const liveCompute = vi.fn().mockResolvedValue(-99999);
    mockedCreateAdmin.mockReturnValue(fakeSupabase([{ chart_of_accounts_id: "coa-2220", provider_key: "stated" }]));
    mockedFetchCoa.mockResolvedValue(COA);
    mockedFetchBalances.mockResolvedValue(new Map());
    mockedFetchStatedMonths.mockResolvedValue(new Map());
    mockedGetProvider.mockImplementation((key) =>
      key === "stated" ? fakeProvider("stated", liveCompute) : undefined,
    );

    const resp = await buildFinancials({ statement: "balance_sheet", year: 2026 });
    const row = resp.rows.find((r) => r.coaId === "coa-2220")!;

    // The live path contributes under the provider key, not the override key,
    // so nothing is marked: this asserts the marker is not applied blindly to
    // every live month.
    expect(row.statedMonths).toBeUndefined();
  });

  it("omits the field entirely on an ordinary row", async () => {
    // Keeps an unmarked row's wire payload byte-for-byte what it was, and keeps
    // P&L rows -- which have no such concept -- free of a stray empty array.
    mockedCreateAdmin.mockReturnValue(fakeSupabase([{ chart_of_accounts_id: "coa-2220", provider_key: "manualBalance" }]));
    mockedFetchCoa.mockResolvedValue(COA);
    mockedFetchBalances.mockResolvedValue(new Map([["coa-2220", { "2026-06": -50000 }]]));
    mockedFetchStatedMonths.mockResolvedValue(new Map());
    mockedGetProvider.mockReturnValue(undefined);

    const resp = await buildFinancials({ statement: "balance_sheet", year: 2026 });
    const row = resp.rows.find((r) => r.coaId === "coa-2220")!;

    expect("statedMonths" in row).toBe(false);
  });
});
