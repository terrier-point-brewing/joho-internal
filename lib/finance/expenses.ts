/**
 * Source-agnostic expense types + pure mapping logic. Expenses can originate
 * from any spend system (Ramp today; others later) — each carries a `source`
 * and the external account it was coded against. No IO here; per-source
 * adapters (e.g. ./rampExpenses) convert their raw records into ExpenseRecord.
 */
import { codesFromRuleAccount } from "./counterpartyHandlers";

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
  amount_cents:          number;   // signed by cash direction: outflow (spend) negative, inflow (refund/credit) positive
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
  /**
   * When this was PAID, as opposed to when it was incurred. Only a bill has a
   * gap between the two, so only the bill adapter sets it -- a card swipe is
   * paid the moment it happens, and a bank line IS the payment.
   *
   * Optional in the type, but the bill adapter always writes it explicitly
   * (a date or null) so that a bill moving from open to paid, or a payment
   * being reversed, is carried through by the upsert rather than leaving a
   * stale value behind.
   *
   * Kept because `state` cannot answer for a past month: it is overwritten in
   * place on every sync, so it says whether a bill is owed TODAY. This says
   * when it stopped being owed, which is what accounts payable needs -- see
   * balances/providers/openBillAp.ts.
   */
  settled_at?:           string | null;
  // The account this expense is coded against in the source system. When the
  // source mirrors the chart of accounts (as Ramp does), this drives auto-map.
  //
  // Only `external_account_id` is a column on `expenses`. The name and code
  // describe the ACCOUNT, not this transaction, so they are carried here just
  // long enough for syncExpenseRecords to create/refresh the account's row in
  // expense_account_mappings -- readers derive the name from there.
  external_account_id:   string | null;
  external_account_name: string | null;
  external_account_code: string | null;
  // For bank-sourced rows with no GL coding: the external party (Gusto, Erie),
  // used to resolve an account from the counterparty rule table.
  counterparty_key:      string | null;
  counterparty_label:    string | null;
  // Ramp → QuickBooks sync state (Ramp's native DIRECT QB integration). Raw
  // per-object-type enum; normalized for display in lib/finance/qbSyncStatus.ts.
  qb_sync_status:        string | null;
  qb_synced_at:          string | null;   // when Ramp pushed it to QB (card txns only)
  qb_remote_id:          string | null;   // QB object id (bills only)
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

export interface CounterpartyRuleRef {
  counterparty_key:     string;
  chart_of_accounts_id: string | null;
  /**
   * Which handler codes this counterparty -- see lib/finance/counterpartyHandlers.
   * Plain `string` rather than a union on purpose: the handler set is data, and
   * every value except the ones whose glEffect is "account" is treated the same
   * way here, so this resolver never needs editing when one is added.
   */
  routing:              string;
}

/**
 * Resolve the effective CoA + source for an expense. Priority: a manual pin wins;
 * else a GL-account rule (card/bill coding); else a counterparty rule (bank
 * lines, which carry no GL) -- unless that counterparty is handled by something
 * other than its own account, in which case it is deliberately left unmapped so
 * the owning feature picks it up (payroll period matching, a balance-sheet
 * calculation); else unmapped.
 */
export function resolveExpenseMapping(
  expense: { external_account_id: string | null; counterparty_key: string | null; mapping_source: MappingSource; chart_of_accounts_id: string | null },
  glRules: Map<string, RuleRef>,
  counterpartyRules: Map<string, CounterpartyRuleRef>,
): { chart_of_accounts_id: string | null; mapping_source: MappingSource } {
  if (expense.mapping_source === "manual") {
    return { chart_of_accounts_id: expense.chart_of_accounts_id, mapping_source: "manual" };
  }
  if (expense.external_account_id) {
    const rule = glRules.get(expense.external_account_id);
    if (rule?.chart_of_accounts_id) return { chart_of_accounts_id: rule.chart_of_accounts_id, mapping_source: "rule" };
  }
  if (expense.counterparty_key) {
    const rule = counterpartyRules.get(expense.counterparty_key);
    if (rule && !codesFromRuleAccount(rule.routing)) return { chart_of_accounts_id: null, mapping_source: "unmapped" };
    if (rule?.chart_of_accounts_id) return { chart_of_accounts_id: rule.chart_of_accounts_id, mapping_source: "rule" };
  }
  return { chart_of_accounts_id: null, mapping_source: "unmapped" };
}
