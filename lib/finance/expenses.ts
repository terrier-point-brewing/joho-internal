/**
 * Source-agnostic expense types + pure mapping logic. Expenses can originate
 * from any spend system (Ramp today; others later) — each carries a `source`
 * and the external account it was coded against. No IO here; per-source
 * adapters (e.g. ./rampExpenses) convert their raw records into ExpenseRecord.
 */

/** Known spend sources. Extend the union (and the DB check) to add another. */
export type ExpenseSource = "ramp" | "square" | "manual";

/** Which Ramp resource an expense row originated from. */
export type RampObject = "card" | "bill" | "bank";

export interface CoaAccountRef {
  id:             string;
  account_name:   string;
  account_number: string | null;
}

/** A row shaped for the `expenses` table (minus resolved mapping). */
export interface ExpenseRecord {
  source:                ExpenseSource;
  ramp_object:           RampObject;
  source_transaction_id: string;   // the source system's transaction id
  amount_cents:          number;   // positive = spend, negative = refund/credit
  currency_code:         string;
  memo:                  string | null;
  merchant_name:         string | null;
  merchant_category:     string | null;
  sk_category_name:      string | null;
  state:                 string | null;
  card_holder_name:      string | null;
  department_name:       string | null;
  transaction_time:      string | null;
  accounting_date:       string | null;
  // The account this expense is coded against in the source system. When the
  // source mirrors the chart of accounts (as Ramp does), this drives auto-map.
  external_account_id:   string | null;
  external_account_name: string | null;
  external_account_code: string | null;
}

export type MappingSource = "unmapped" | "rule" | "manual";

/** Dollars → integer cents, half-away-from-zero. */
export function dollarsToCents(amount: number): number {
  return Math.round(amount * 100);
}

/** Normalize an account name for fuzzy comparison (case/space-insensitive). */
function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Leaf of a QuickBooks-style "Parent:Child:Leaf" account name. */
function leafName(name: string): string {
  const parts = name.split(":");
  return normName(parts[parts.length - 1]);
}

/**
 * Directly match a source's external account to a chart-of-accounts row.
 * Priority: exact account number → exact full name → unambiguous leaf name.
 * Returns the CoA id, or null when nothing matches confidently.
 */
export function matchAccountToCoa(
  external: { name: string; code?: string | null },
  accounts: CoaAccountRef[],
): string | null {
  const code = external.code?.trim();
  if (code) {
    const byNumber = accounts.find((a) => a.account_number?.trim() === code);
    if (byNumber) return byNumber.id;
  }

  const extName = external.name ? normName(external.name) : "";
  if (!extName) return null;

  const byFull = accounts.find((a) => normName(a.account_name) === extName);
  if (byFull) return byFull.id;

  const extLeaf = leafName(external.name);
  const byLeaf = accounts.filter((a) => leafName(a.account_name) === extLeaf);
  if (byLeaf.length === 1) return byLeaf[0].id;

  return null;
}

export interface RuleRef {
  external_account_id:  string;
  chart_of_accounts_id: string | null;
}

/**
 * Resolve the effective CoA + source for an expense given the current rule set.
 * Manual overrides are preserved. Otherwise the expense follows its external
 * account's rule; an untagged expense (or a rule with no account) stays unmapped.
 */
export function resolveExpenseMapping(
  expense: { external_account_id: string | null; mapping_source: MappingSource; chart_of_accounts_id: string | null },
  ruleByAccountId: Map<string, RuleRef>,
): { chart_of_accounts_id: string | null; mapping_source: MappingSource } {
  if (expense.mapping_source === "manual") {
    return { chart_of_accounts_id: expense.chart_of_accounts_id, mapping_source: "manual" };
  }
  if (!expense.external_account_id) {
    return { chart_of_accounts_id: null, mapping_source: "unmapped" };
  }
  const rule = ruleByAccountId.get(expense.external_account_id);
  if (rule?.chart_of_accounts_id) {
    return { chart_of_accounts_id: rule.chart_of_accounts_id, mapping_source: "rule" };
  }
  return { chart_of_accounts_id: null, mapping_source: "unmapped" };
}
