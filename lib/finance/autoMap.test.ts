import { describe, it, expect } from "vitest";
import { resolveBankBackfill, resolvePosBackfill, resolveInvoiceBackfill, counterpartyRuleKey, type CounterpartyRule } from "./autoMap";

/** A rule that names an account and takes no view on the flow — the shape every rule had before flow types. */
const account = (id: string): CounterpartyRule => ({ chart_of_accounts_id: id, flow_type: null });

describe("resolveBankBackfill", () => {
  const rules = new Map<string, CounterpartyRule>([[counterpartyRuleKey("ramp", "gusto"), account("coa-payroll")]]);

  /**
   * A row whose flow is already settled and does use an account — the ordinary
   * Ramp case, since that importer classifies every line as it arrives. Tests
   * about an account-only rule have to use one of these: an unclassified row
   * deliberately takes no account at all (see below).
   */
  const expenseRow = (over: Record<string, unknown> = {}) => ({
    id: "r1", source: "ramp", counterparty_key: "gusto", mapping_source: "unmapped",
    chart_of_accounts_id: null, flow_type: "operating_expense", ...over,
  });

  it("maps an unmapped row whose counterparty has a rule", () => {
    expect(resolveBankBackfill([expenseRow()], rules)).toEqual([{ id: "r1", chart_of_accounts_id: "coa-payroll" }]);
  });

  // The account waits for the flow rather than landing on a row nothing counts.
  // Writing it early produced the one state the grid has to draw a warning for:
  // an account with no visible picker, on a row contributing to nothing.
  it("gives an UNCLASSIFIED row nothing at all, account included", () => {
    expect(resolveBankBackfill([expenseRow({ flow_type: "unclassified" })], rules)).toEqual([]);
    expect(resolveBankBackfill([expenseRow({ flow_type: null })], rules)).toEqual([]);
  });

  it("fills the account as soon as the flow is answered", () => {
    expect(resolveBankBackfill([expenseRow({ flow_type: "other_income" })], rules))
      .toEqual([{ id: "r1", chart_of_accounts_id: "coa-payroll" }]);
  });

  it("never gives a settlement or a transfer an account", () => {
    for (const flow of ["card_settlement", "bill_settlement", "deposit", "internal_transfer"]) {
      expect(resolveBankBackfill([expenseRow({ flow_type: flow })], rules)).toEqual([]);
    }
  });

  it("never overwrites a manual pin", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", source: "ramp", counterparty_key: "gusto", mapping_source: "manual", chart_of_accounts_id: "coa-x" }],
      rules,
    );
    expect(out).toEqual([]);
  });

  it("never overwrites an already-mapped row (fill-nulls-only)", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", source: "ramp", counterparty_key: "gusto", mapping_source: "rule", chart_of_accounts_id: "coa-old" }],
      rules,
    );
    expect(out).toEqual([]);
  });

  it("skips rows whose counterparty has no rule", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", source: "ramp", counterparty_key: "unknown", mapping_source: "unmapped", chart_of_accounts_id: null }],
      rules,
    );
    expect(out).toEqual([]);
  });

  it("skips rows with a null counterparty_key", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", source: "ramp", counterparty_key: null, mapping_source: "unmapped", chart_of_accounts_id: null }],
      rules,
    );
    expect(out).toEqual([]);
  });

  it("does not lend one bank's rule to another bank's counterparty of the same name", () => {
    // The whole reason a rule is keyed by (feed, counterparty): a Chase payee
    // called GUSTO is a different relationship from the Ramp payee called GUSTO,
    // and inheriting the Ramp account would post real money to it unasked.
    const out = resolveBankBackfill(
      [{ id: "r1", source: "plaid", counterparty_key: "gusto", mapping_source: "unmapped", chart_of_accounts_id: null }],
      rules,
    );
    expect(out).toEqual([]);
  });

  it("uses each feed's own rule when both feeds have one for the same name", () => {
    const both = new Map<string, CounterpartyRule>([
      [counterpartyRuleKey("ramp", "gusto"), account("coa-payroll")],
      [counterpartyRuleKey("plaid", "gusto"), account("coa-other")],
    ]);
    const out = resolveBankBackfill(
      [
        { id: "r1", source: "ramp",  counterparty_key: "gusto", mapping_source: "unmapped", chart_of_accounts_id: null, flow_type: "operating_expense" },
        { id: "r2", source: "plaid", counterparty_key: "gusto", mapping_source: "unmapped", chart_of_accounts_id: null, flow_type: "operating_expense" },
      ],
      both,
    );
    expect(out).toEqual([
      { id: "r1", chart_of_accounts_id: "coa-payroll" },
      { id: "r2", chart_of_accounts_id: "coa-other" },
    ]);
  });

  describe("a rule that carries a flow type", () => {
    const flowRules = new Map<string, CounterpartyRule>([
      [counterpartyRuleKey("plaid", "ramp wallet"), { chart_of_accounts_id: null, flow_type: "internal_transfer" }],
      [counterpartyRuleKey("plaid", "erie insurance"), { chart_of_accounts_id: "coa-ins", flow_type: "operating_expense" }],
    ]);
    const row = (over: Record<string, unknown> = {}) => ({
      id: "r1", source: "plaid", counterparty_key: null, counterparty_name: "Ramp Wallet",
      mapping_source: "unmapped", chart_of_accounts_id: null, flow_type: "unclassified", ...over,
    });

    it("classifies a row without giving it an account it cannot use", () => {
      expect(resolveBankBackfill([row()], flowRules)).toEqual([
        { id: "r1", chart_of_accounts_id: null, flow_type: "internal_transfer", affects_pl: false },
      ]);
    });

    // The bug the whole registry exists to close: an operating expense has to
    // reach the P&L, and affects_pl is what the reader filters on.
    it("sets affects_pl from the flow, so an expense actually reaches the P&L", () => {
      const out = resolveBankBackfill([row({ counterparty_name: "Erie Insurance" })], flowRules);
      expect(out).toEqual([
        { id: "r1", chart_of_accounts_id: "coa-ins", flow_type: "operating_expense", affects_pl: true },
      ]);
    });

    it("leaves a row that already says what it is", () => {
      expect(resolveBankBackfill([row({ flow_type: "deposit" })], flowRules)).toEqual([]);
    });

    it("still fills an account on an already-classified row when the flow uses one", () => {
      const out = resolveBankBackfill(
        [row({ counterparty_name: "Erie Insurance", flow_type: "operating_expense" })],
        flowRules,
      );
      expect(out).toEqual([{ id: "r1", chart_of_accounts_id: "coa-ins" }]);
    });

    // A half-changed rule: somebody set the flow to a transfer and left the old
    // account behind. The balance-sheet reader matches on the account alone, so
    // leaving it would go on moving a reported balance.
    it("clears an account the newly applied flow cannot hold", () => {
      const half = new Map<string, CounterpartyRule>([
        [counterpartyRuleKey("plaid", "ramp wallet"), { chart_of_accounts_id: "coa-stale", flow_type: "internal_transfer" }],
      ]);
      const out = resolveBankBackfill([row({ chart_of_accounts_id: "coa-stale" })], half);
      expect(out).toEqual([
        { id: "r1", chart_of_accounts_id: null, flow_type: "internal_transfer", affects_pl: false },
      ]);
    });

    it("never touches a manual row, flow or account", () => {
      expect(resolveBankBackfill([row({ mapping_source: "manual" })], flowRules)).toEqual([]);
    });

    // A rule with no flow never classifies; it only ever fills an account, and
    // only on a row whose own flow already uses one.
    it("an account-only rule leaves the flow alone", () => {
      const out = resolveBankBackfill(
        [row({ counterparty_name: "Gusto", source: "ramp", counterparty_key: "gusto", flow_type: "operating_expense" })],
        rules,
      );
      expect(out).toEqual([{ id: "r1", chart_of_accounts_id: "coa-payroll" }]);
    });
  });
});

describe("resolvePosBackfill", () => {
  const coaByVar = new Map<string, string>([["v1", "coa-beer"]]);

  it("maps unmapped line items whose variation has a mapping", () => {
    const out = resolvePosBackfill([{ id: "li1", square_variation_id: "v1" }], coaByVar);
    expect(out).toEqual([{ id: "li1", chart_of_accounts_id: "coa-beer" }]);
  });

  it("skips items with no variation or no mapping", () => {
    const out = resolvePosBackfill(
      [{ id: "li1", square_variation_id: null }, { id: "li2", square_variation_id: "vX" }],
      coaByVar,
    );
    expect(out).toEqual([]);
  });
});

describe("resolveInvoiceBackfill", () => {
  const byDesc = new Map<string, string>([
    ["hazy ipa — 1/6 bbl", "coa-dist"],
    ["keg cleaning service", "coa-svc"],
  ]);

  it("maps a catalog-backed line by its composed label", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", line_item_name: "Hazy IPA", variation_name: "1/6 BBL", note: null, chart_of_accounts_id: null }],
      byDesc,
    );
    expect(out).toEqual([{ id: "il1", chart_of_accounts_id: "coa-dist" }]);
  });

  it("composes the label from line_item_name alone when there is no variation", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", line_item_name: "Keg Cleaning Service", variation_name: null, note: null, chart_of_accounts_id: null }],
      byDesc,
    );
    expect(out).toEqual([{ id: "il1", chart_of_accounts_id: "coa-svc" }]);
  });

  it("uses the note as the label for a manual line with no catalog identity", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", line_item_name: null, variation_name: null, note: "Hazy IPA — 1/6 BBL", chart_of_accounts_id: null }],
      byDesc,
    );
    expect(out).toEqual([{ id: "il1", chart_of_accounts_id: "coa-dist" }]);
  });

  it("ignores the note on a catalog-backed line, which is a note and not a label", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", line_item_name: "Mystery Item", variation_name: null, note: "Hazy IPA — 1/6 BBL", chart_of_accounts_id: null }],
      byDesc,
    );
    expect(out).toEqual([]);
  });

  it("never overwrites an already-mapped item", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", line_item_name: "Hazy IPA", variation_name: "1/6 BBL", note: null, chart_of_accounts_id: "coa-x" }],
      byDesc,
    );
    expect(out).toEqual([]);
  });

  it("skips items whose label has no match", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", line_item_name: null, variation_name: null, note: "Mystery", chart_of_accounts_id: null }],
      byDesc,
    );
    expect(out).toEqual([]);
  });

  it("skips a line that has neither catalog identity nor a note", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", line_item_name: null, variation_name: null, note: null, chart_of_accounts_id: null }],
      byDesc,
    );
    expect(out).toEqual([]);
  });

  it("maps by catalog variation id (primary) even when the label does not match", () => {
    const byVar = new Map<string, string>([["VAR1", "coa-var"]]);
    const out = resolveInvoiceBackfill(
      [{ id: "il1", line_item_name: "Packaging Fee", variation_name: null, note: null, square_catalog_variation_id: "VAR1", chart_of_accounts_id: null }],
      byDesc,
      byVar,
    );
    expect(out).toEqual([{ id: "il1", chart_of_accounts_id: "coa-var" }]);
  });

  it("prefers the variation match over a conflicting label match", () => {
    const byVar = new Map<string, string>([["VAR1", "coa-var"]]);
    const out = resolveInvoiceBackfill(
      [{ id: "il1", line_item_name: "Hazy IPA", variation_name: "1/6 BBL", note: null, square_catalog_variation_id: "VAR1", chart_of_accounts_id: null }],
      byDesc,
      byVar,
    );
    expect(out).toEqual([{ id: "il1", chart_of_accounts_id: "coa-var" }]);
  });

  it("falls back to the label when the line has no variation id", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", line_item_name: "Hazy IPA", variation_name: "1/6 BBL", note: null, square_catalog_variation_id: null, chart_of_accounts_id: null }],
      byDesc,
      new Map(),
    );
    expect(out).toEqual([{ id: "il1", chart_of_accounts_id: "coa-dist" }]);
  });

  it("keys a renamed catalog item off its CURRENT name, which a stored copy could not", () => {
    const byCurrent = new Map<string, string>([["epic hazy ipa (keg) — 1/2 keg", "coa-keg"]]);
    const out = resolveInvoiceBackfill(
      [{ id: "il1", line_item_name: "Epic Hazy IPA (Keg)", variation_name: "1/2 Keg", note: null, chart_of_accounts_id: null }],
      byCurrent,
    );
    expect(out).toEqual([{ id: "il1", chart_of_accounts_id: "coa-keg" }]);
  });
});
