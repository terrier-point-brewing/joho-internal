import { describe, it, expect, beforeEach } from "vitest";
import {
  registerProvider,
  getProvider,
  listProviders,
  __resetRegistry,
} from "./registry";
import type { BalanceProvider } from "./registry";
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
