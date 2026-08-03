import { describe, it, expect, beforeEach } from "vitest";
import {
  registerProvider,
  getProvider,
  listProviders,
  createSharedComputeCache,
  sharedRead,
  __resetRegistry,
} from "./registry";
import type { BalanceContext, BalanceProvider } from "./registry";
import type { CoaAccountRef } from "../financials/types";

function makeProvider(overrides: Partial<BalanceProvider> = {}): BalanceProvider {
  return {
    key: "test-provider",
    label: "Test Provider",
    kind: "derived",
    compute: async () => null,
    ...overrides,
  };
}

describe("balance provider registry", () => {
  beforeEach(() => {
    __resetRegistry();
  });

  it("registers a provider and retrieves it by key", () => {
    const provider = makeProvider({ key: "taxAccrual", label: "Tax Accrual" });

    registerProvider(provider);
    const retrieved = getProvider("taxAccrual");

    expect(retrieved).toBe(provider);
    expect(retrieved?.label).toBe("Tax Accrual");
  });

  it("returns undefined for an unknown key", () => {
    expect(getProvider("does-not-exist")).toBeUndefined();
  });

  it("throws when registering a duplicate key", () => {
    const provider = makeProvider({ key: "duplicate" });
    registerProvider(provider);

    expect(() => registerProvider(makeProvider({ key: "duplicate" }))).toThrow();
  });

  it("lists every registered provider", () => {
    const providerA = makeProvider({ key: "a" });
    const providerB = makeProvider({ key: "b" });

    registerProvider(providerA);
    registerProvider(providerB);

    const providers = listProviders();
    expect(providers).toHaveLength(2);
    expect(providers).toEqual(expect.arrayContaining([providerA, providerB]));
  });

  it("filters accounts via appliesTo for a mixed set of CoaAccountRefs", () => {
    const liabilityOnly = makeProvider({
      key: "liabilityOnly",
      appliesTo: (coa) => coa.statementSection === "liabilities",
    });

    const accounts: CoaAccountRef[] = [
      {
        id: "1",
        parentId: null,
        accountName: "Sales Tax Payable",
        accountNumber: "2220",
        statementSection: "liabilities",
      },
      {
        id: "2",
        parentId: null,
        accountName: "Cash",
        accountNumber: "1000",
        statementSection: "assets",
      },
      {
        id: "3",
        parentId: null,
        accountName: "Wake County Tax Payable",
        accountNumber: "2250",
        statementSection: "liabilities",
      },
    ];

    const matched = accounts.filter((coa) => liabilityOnly.appliesTo?.(coa));

    expect(matched.map((coa) => coa.id)).toEqual(["1", "3"]);
  });
});

/**
 * The memo that keeps taxAccrual's 9.7k-row collections scan from running once
 * per tax account. Its two load-bearing properties are that it dedupes reads
 * still IN FLIGHT (the accounts run concurrently now, so a value-only cache
 * would be empty at the moment the second caller arrives) and that it is
 * per-run, never module-scoped.
 */
describe("sharedRead", () => {
  function ctx(overrides: Partial<BalanceContext> = {}): BalanceContext {
    return {
      supabase: {} as BalanceContext["supabase"],
      periodEnd: "2026-08-31",
      coaId: "coa-2220",
      config: {},
      shared: createSharedComputeCache(),
      ...overrides,
    };
  }

  it("runs the read once per key and gives every caller the same answer", async () => {
    const c = ctx();
    let calls = 0;
    const read = async () => { calls++; return 42; };

    expect(await sharedRead(c, "k", read)).toBe(42);
    expect(await sharedRead(c, "k", read)).toBe(42);
    expect(calls).toBe(1);
  });

  it("joins a read still in flight rather than starting a second one", async () => {
    const c = ctx();
    let calls = 0;
    let release!: (v: number) => void;
    const read = () => { calls++; return new Promise<number>((r) => { release = r; }); };

    // Both callers arrive before the first read resolves — the concurrent case.
    const both = Promise.all([sharedRead(c, "k", read), sharedRead(c, "k", read)]);
    release(7);

    expect(await both).toEqual([7, 7]);
    expect(calls).toBe(1);
  });

  it("keeps different keys apart", async () => {
    const c = ctx();
    expect(await sharedRead(c, "a", async () => 1)).toBe(1);
    expect(await sharedRead(c, "b", async () => 2)).toBe(2);
  });

  it("shares nothing between two runs", async () => {
    let calls = 0;
    const read = async () => { calls++; return 1; };

    await sharedRead(ctx(), "k", read);
    await sharedRead(ctx(), "k", read);

    expect(calls).toBe(2);
  });

  it("reads afresh when no cache was supplied, so a directly-called provider still works", async () => {
    const c = ctx({ shared: undefined });
    let calls = 0;
    const read = async () => { calls++; return 1; };

    await sharedRead(c, "k", read);
    await sharedRead(c, "k", read);

    expect(calls).toBe(2);
  });

  it("gives the second caller the first's failure instead of re-running it", async () => {
    const c = ctx();
    let calls = 0;
    const read = async () => { calls++; throw new Error("square unreachable"); };

    await expect(sharedRead(c, "k", read)).rejects.toThrow("square unreachable");
    await expect(sharedRead(c, "k", read)).rejects.toThrow("square unreachable");
    expect(calls).toBe(1);
  });
});
