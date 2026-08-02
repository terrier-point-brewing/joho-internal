import { describe, it, expect } from "vitest";
import {
  dollarsToCents,
  matchAccountToCoa,
  resolveExpenseMapping,
  type CoaAccountRef,
  type RuleRef,
  type CounterpartyRuleRef,
  type MappingSource,
} from "./expenses";

describe("dollarsToCents", () => {
  it("converts and rounds half-away-from-zero", () => {
    expect(dollarsToCents(12.34)).toBe(1234);
    expect(dollarsToCents(0)).toBe(0);
    expect(dollarsToCents(-5.5)).toBe(-550);
    expect(dollarsToCents(1.01)).toBe(101);
  });
});

describe("matchAccountToCoa", () => {
  const accounts: CoaAccountRef[] = [
    { id: "a1", account_name: "Meals & Entertainment", account_number: "6000" },
    { id: "a2", account_name: "Office Expenses:Software", account_number: "6100" },
    { id: "a3", account_name: "Utilities", account_number: null },
    { id: "a4", account_name: "Rent:Warehouse:Software", account_number: "6200" },
  ];

  it("matches by account number first", () => {
    expect(matchAccountToCoa({ name: "whatever", code: "6000" }, accounts)).toBe("a1");
  });

  it("matches by exact full name (case/space-insensitive) when no number", () => {
    expect(matchAccountToCoa({ name: "  meals &   entertainment " }, accounts)).toBe("a1");
  });

  it("matches by unambiguous leaf name", () => {
    expect(matchAccountToCoa({ name: "Software" }, [accounts[0], accounts[1]])).toBe("a2");
  });

  it("does not match an ambiguous leaf name", () => {
    expect(matchAccountToCoa({ name: "Software" }, accounts)).toBeNull();
  });

  it("returns null when nothing matches or name is empty", () => {
    expect(matchAccountToCoa({ name: "Nonexistent", code: "9999" }, accounts)).toBeNull();
    expect(matchAccountToCoa({ name: "" }, accounts)).toBeNull();
  });
});

describe("resolveExpenseMapping", () => {
  const rules = new Map<string, RuleRef>([
    ["acct-1", { external_account_id: "acct-1", chart_of_accounts_id: "a1" }],
    ["acct-2", { external_account_id: "acct-2", chart_of_accounts_id: null }],
  ]);
  const emptyCounterpartyRules = new Map<string, CounterpartyRuleRef>();

  const base = (over: Partial<{ external_account_id: string | null; counterparty_key: string | null; mapping_source: MappingSource; chart_of_accounts_id: string | null }>) =>
    ({ external_account_id: "acct-1", counterparty_key: null, mapping_source: "unmapped" as MappingSource, chart_of_accounts_id: null, ...over });

  it("preserves a manual override untouched", () => {
    const r = resolveExpenseMapping(base({ mapping_source: "manual", chart_of_accounts_id: "manual-acct" }), rules, emptyCounterpartyRules);
    expect(r).toEqual({ chart_of_accounts_id: "manual-acct", mapping_source: "manual" });
  });

  it("resolves via the account rule", () => {
    expect(resolveExpenseMapping(base({}), rules, emptyCounterpartyRules)).toEqual({ chart_of_accounts_id: "a1", mapping_source: "rule" });
  });

  it("stays unmapped when the rule has no account", () => {
    expect(resolveExpenseMapping(base({ external_account_id: "acct-2" }), rules, emptyCounterpartyRules)).toEqual({ chart_of_accounts_id: null, mapping_source: "unmapped" });
  });

  it("stays unmapped when there is no external account or no matching rule", () => {
    expect(resolveExpenseMapping(base({ external_account_id: null }), rules, emptyCounterpartyRules)).toEqual({ chart_of_accounts_id: null, mapping_source: "unmapped" });
    expect(resolveExpenseMapping(base({ external_account_id: "unknown" }), rules, emptyCounterpartyRules)).toEqual({ chart_of_accounts_id: null, mapping_source: "unmapped" });
  });
});

describe("resolveExpenseMapping with counterparty rules", () => {
  const gl = new Map<string, RuleRef>([["ext-1", { external_account_id: "ext-1", chart_of_accounts_id: "coa-gl" }]]);
  const cp = new Map<string, CounterpartyRuleRef>([
    ["gusto", { counterparty_key: "gusto", chart_of_accounts_id: "coa-payroll", routing: "single_account" }],
  ]);

  it("resolves via counterparty rule when there is no GL account", () => {
    const r = resolveExpenseMapping(
      { external_account_id: null, counterparty_key: "gusto", mapping_source: "unmapped", chart_of_accounts_id: null }, gl, cp);
    expect(r).toEqual({ chart_of_accounts_id: "coa-payroll", mapping_source: "rule" });
  });

  it("prefers the GL rule over the counterparty rule", () => {
    const r = resolveExpenseMapping(
      { external_account_id: "ext-1", counterparty_key: "gusto", mapping_source: "unmapped", chart_of_accounts_id: null }, gl, cp);
    expect(r.chart_of_accounts_id).toBe("coa-gl");
  });

  it("keeps a manual pin untouched", () => {
    const r = resolveExpenseMapping(
      { external_account_id: null, counterparty_key: "gusto", mapping_source: "manual", chart_of_accounts_id: "coa-pinned" }, gl, cp);
    expect(r).toEqual({ chart_of_accounts_id: "coa-pinned", mapping_source: "manual" });
  });

  it("is unmapped when neither key resolves", () => {
    const r = resolveExpenseMapping(
      { external_account_id: null, counterparty_key: "unknown", mapping_source: "unmapped", chart_of_accounts_id: null }, gl, cp);
    expect(r).toEqual({ chart_of_accounts_id: null, mapping_source: "unmapped" });
  });
});

describe("resolveExpenseMapping with a payroll_split-routed counterparty rule", () => {
  const emptyGl = new Map<string, RuleRef>();
  const payrollCp = new Map<string, CounterpartyRuleRef>([
    ["gusto", { counterparty_key: "gusto", chart_of_accounts_id: "coa-payroll", routing: "payroll_split" }],
  ]);

  it("never applies a payroll_split rule -- expense comes back unmapped instead of coded to the rule's account", () => {
    const r = resolveExpenseMapping(
      { external_account_id: null, counterparty_key: "gusto", mapping_source: "unmapped", chart_of_accounts_id: null },
      emptyGl,
      payrollCp,
    );
    expect(r).toEqual({ chart_of_accounts_id: null, mapping_source: "unmapped" });
  });

  it("still preserves a manual pin even when the counterparty rule is payroll_split", () => {
    const r = resolveExpenseMapping(
      { external_account_id: null, counterparty_key: "gusto", mapping_source: "manual", chart_of_accounts_id: "coa-pinned" },
      emptyGl,
      payrollCp,
    );
    expect(r).toEqual({ chart_of_accounts_id: "coa-pinned", mapping_source: "manual" });
  });

  it("a single_account rule (the default) behaves exactly as before -- pure addition, not a behavior change", () => {
    const singleAccountCp = new Map<string, CounterpartyRuleRef>([
      ["gusto", { counterparty_key: "gusto", chart_of_accounts_id: "coa-payroll", routing: "single_account" }],
    ]);
    const r = resolveExpenseMapping(
      { external_account_id: null, counterparty_key: "gusto", mapping_source: "unmapped", chart_of_accounts_id: null },
      emptyGl,
      singleAccountCp,
    );
    expect(r).toEqual({ chart_of_accounts_id: "coa-payroll", mapping_source: "rule" });
  });
});

/**
 * The resolver stopped naming payroll_split and now asks the handler registry
 * whether a routing value codes from the rule's own account. These cover the
 * property that makes adding a handler free here: anything that is not
 * "account" is left for whoever does own it, with no branch of its own.
 */
describe("resolveExpenseMapping with a counterparty handled somewhere other than this rule", () => {
  const emptyGl = new Map<string, RuleRef>();

  function resolve(routing: string, chart_of_accounts_id: string | null = "coa-stale") {
    return resolveExpenseMapping(
      { external_account_id: null, counterparty_key: "square", mapping_source: "unmapped", chart_of_accounts_id: null },
      emptyGl,
      new Map<string, CounterpartyRuleRef>([["square", { counterparty_key: "square", chart_of_accounts_id, routing }]]),
    );
  }

  it("leaves a balance-sheet-handled counterparty unmapped, even with an account still on the row", () => {
    // Coding a Square deposit to the Square account would ADD to the balance it
    // emptied — 1040 is a bank-section account, so its cash direction passes
    // through unchanged. The account on the row is a decision taken before the
    // calculation existed and must not be honoured.
    expect(resolve("balance_sheet")).toEqual({ chart_of_accounts_id: null, mapping_source: "unmapped" });
  });

  it("leaves a counterparty routed to an unrecognised handler unmapped rather than coding it", () => {
    // A handler removed in a rollback, or a row written by a newer deploy.
    // Unmapped surfaces it for a human; the alternative codes real money to
    // whatever account happened to be sitting there.
    expect(resolve("handler_from_a_later_deploy")).toEqual({ chart_of_accounts_id: null, mapping_source: "unmapped" });
  });

  it("still lets a GL-account rule win, because that is coding the expense already carried", () => {
    // The counterparty rule is the fallback for bank lines, which have no GL of
    // their own. A card or bill that came in already coded is not affected by
    // who handles the payee.
    const r = resolveExpenseMapping(
      { external_account_id: "ext-1", counterparty_key: "square", mapping_source: "unmapped", chart_of_accounts_id: null },
      new Map<string, RuleRef>([["ext-1", { external_account_id: "ext-1", chart_of_accounts_id: "coa-fees" }]]),
      new Map<string, CounterpartyRuleRef>([["square", { counterparty_key: "square", chart_of_accounts_id: null, routing: "balance_sheet" }]]),
    );
    expect(r).toEqual({ chart_of_accounts_id: "coa-fees", mapping_source: "rule" });
  });
});
