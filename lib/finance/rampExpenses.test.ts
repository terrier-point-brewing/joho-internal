import { describe, it, expect } from "vitest";
import {
  dollarsToCents,
  rampTxnToExpenseRecord,
  matchGlToCoa,
  resolveExpenseMapping,
  type CoaAccountRef,
  type RuleRef,
  type MappingSource,
} from "./rampExpenses";
import type { RampTransaction } from "@/lib/ramp";

function txn(over: Partial<RampTransaction> = {}): RampTransaction {
  return {
    id: "t1",
    amount: 12.34,
    currency_code: "USD",
    memo: "lunch",
    merchant_name: "Cafe",
    merchant_category_code_description: "Restaurants",
    sk_category_name: "Meals",
    state: "CLEARED",
    user_transaction_time: "2026-06-15T14:00:00Z",
    accounting_date: "2026-06-15T00:00:00Z",
    gl_account: { id: "gl-1", external_id: "6000", name: "Meals & Entertainment" },
    card_holder: { first_name: "Sam", last_name: "Doe", department_name: "Ops", user_id: "u1" },
    ...over,
  };
}

describe("dollarsToCents", () => {
  it("converts and rounds half-away-from-zero", () => {
    expect(dollarsToCents(12.34)).toBe(1234);
    expect(dollarsToCents(0)).toBe(0);
    expect(dollarsToCents(-5.5)).toBe(-550);
    expect(dollarsToCents(1.01)).toBe(101);
  });
});

describe("rampTxnToExpenseRecord", () => {
  it("shapes a clean record with GL fields and cents", () => {
    const r = rampTxnToExpenseRecord(txn());
    expect(r).toMatchObject({
      ramp_transaction_id: "t1",
      amount_cents: 1234,
      currency_code: "USD",
      memo: "lunch",
      merchant_name: "Cafe",
      merchant_category: "Restaurants",
      sk_category_name: "Meals",
      state: "CLEARED",
      card_holder_name: "Sam Doe",
      department_name: "Ops",
      accounting_date: "2026-06-15",
      ramp_gl_id: "gl-1",
      ramp_gl_name: "Meals & Entertainment",
      ramp_gl_code: "6000",
    });
  });

  it("nulls empty strings and a missing GL account", () => {
    const r = rampTxnToExpenseRecord(txn({
      memo: "",
      merchant_name: "",
      sk_category_name: null,
      accounting_date: "",
      gl_account: null,
      card_holder: { first_name: "", last_name: "", department_name: "", user_id: "u" },
    }));
    expect(r.memo).toBeNull();
    expect(r.merchant_name).toBeNull();
    expect(r.sk_category_name).toBeNull();
    expect(r.accounting_date).toBeNull();
    expect(r.card_holder_name).toBeNull();
    expect(r.department_name).toBeNull();
    expect(r.ramp_gl_id).toBeNull();
    expect(r.currency_code).toBe("USD");
  });
});

describe("matchGlToCoa", () => {
  const accounts: CoaAccountRef[] = [
    { id: "a1", account_name: "Meals & Entertainment", account_number: "6000" },
    { id: "a2", account_name: "Office Expenses:Software", account_number: "6100" },
    { id: "a3", account_name: "Utilities", account_number: null },
    { id: "a4", account_name: "Rent:Warehouse:Software", account_number: "6200" },
  ];

  it("matches by account number first", () => {
    expect(matchGlToCoa({ name: "whatever", external_id: "6000" }, accounts)).toBe("a1");
  });

  it("matches by exact full name (case/space-insensitive) when no number", () => {
    expect(matchGlToCoa({ name: "  meals &   entertainment " }, accounts)).toBe("a1");
  });

  it("matches by unambiguous leaf name", () => {
    expect(matchGlToCoa({ name: "Software" }, [accounts[0], accounts[1]])).toBe("a2");
  });

  it("does not match an ambiguous leaf name", () => {
    // "Software" is the leaf of both a2 and a4
    expect(matchGlToCoa({ name: "Software" }, accounts)).toBeNull();
  });

  it("returns null when nothing matches or name is empty", () => {
    expect(matchGlToCoa({ name: "Nonexistent", external_id: "9999" }, accounts)).toBeNull();
    expect(matchGlToCoa({ name: "" }, accounts)).toBeNull();
  });
});

describe("resolveExpenseMapping", () => {
  const rules = new Map<string, RuleRef>([
    ["gl-1", { ramp_gl_id: "gl-1", chart_of_accounts_id: "a1" }],
    ["gl-2", { ramp_gl_id: "gl-2", chart_of_accounts_id: null }],
  ]);

  const base = (over: Partial<{ ramp_gl_id: string | null; mapping_source: MappingSource; chart_of_accounts_id: string | null }>) =>
    ({ ramp_gl_id: "gl-1", mapping_source: "unmapped" as MappingSource, chart_of_accounts_id: null, ...over });

  it("preserves a manual override untouched", () => {
    const r = resolveExpenseMapping(base({ mapping_source: "manual", chart_of_accounts_id: "manual-acct" }), rules);
    expect(r).toEqual({ chart_of_accounts_id: "manual-acct", mapping_source: "manual" });
  });

  it("resolves via the GL rule", () => {
    expect(resolveExpenseMapping(base({}), rules)).toEqual({ chart_of_accounts_id: "a1", mapping_source: "rule" });
  });

  it("stays unmapped when the rule has no account", () => {
    expect(resolveExpenseMapping(base({ ramp_gl_id: "gl-2" }), rules)).toEqual({ chart_of_accounts_id: null, mapping_source: "unmapped" });
  });

  it("stays unmapped when there is no GL tag or no matching rule", () => {
    expect(resolveExpenseMapping(base({ ramp_gl_id: null }), rules)).toEqual({ chart_of_accounts_id: null, mapping_source: "unmapped" });
    expect(resolveExpenseMapping(base({ ramp_gl_id: "gl-unknown" }), rules)).toEqual({ chart_of_accounts_id: null, mapping_source: "unmapped" });
  });
});
