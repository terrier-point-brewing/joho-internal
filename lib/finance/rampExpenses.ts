/**
 * Pure logic for importing Ramp expenses and mapping them to the chart of
 * accounts. No IO here — the sync route wires these to Ramp + Supabase.
 *
 * Mapping strategy: Ramp mirrors the same chart of accounts, so each expense
 * carries a GL account (from the transaction's accounting_field_selections).
 * We match that GL account to a `chart_of_accounts` row by number, then by
 * name, so most expenses map with zero user effort. Matches are persisted as
 * reusable rules (one per Ramp GL account) so re-imports stay free.
 */
import type { RampTransaction } from "@/lib/ramp";

export interface CoaAccountRef {
  id:             string;
  account_name:   string;
  account_number: string | null;
}

/** A row shaped for the `ramp_expenses` table (minus resolved mapping). */
export interface RampExpenseRecord {
  ramp_transaction_id: string;
  amount_cents:        number;
  currency_code:       string;
  memo:                string | null;
  merchant_name:       string | null;
  merchant_category:   string | null;
  sk_category_name:    string | null;
  state:               string | null;
  card_holder_name:    string | null;
  department_name:     string | null;
  transaction_time:    string | null;
  accounting_date:     string | null;
  ramp_gl_id:          string | null;
  ramp_gl_name:        string | null;
  ramp_gl_code:        string | null;
}

export type MappingSource = "unmapped" | "rule" | "manual";

/** Dollars (Ramp's native unit) → integer cents, half-away-from-zero. */
export function dollarsToCents(amount: number): number {
  return Math.round(amount * 100);
}

function cleanDate(iso: string): string | null {
  return iso ? iso.slice(0, 10) : null;
}

/** Shape a raw Ramp transaction into a clean, DB-ready expense record. */
export function rampTxnToExpenseRecord(txn: RampTransaction): RampExpenseRecord {
  const holder = [txn.card_holder.first_name, txn.card_holder.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    ramp_transaction_id: txn.id,
    amount_cents:        dollarsToCents(txn.amount),
    currency_code:       txn.currency_code || "USD",
    memo:                txn.memo || null,
    merchant_name:       txn.merchant_name || null,
    merchant_category:   txn.merchant_category_code_description || null,
    sk_category_name:    txn.sk_category_name || null,
    state:               txn.state || null,
    card_holder_name:    holder || null,
    department_name:     txn.card_holder.department_name || null,
    transaction_time:    txn.user_transaction_time || null,
    accounting_date:     cleanDate(txn.accounting_date),
    ramp_gl_id:          txn.gl_account?.id ?? null,
    ramp_gl_name:        txn.gl_account?.name ?? null,
    ramp_gl_code:        txn.gl_account?.external_id ?? null,
  };
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
 * Directly match a Ramp GL account to a chart-of-accounts row.
 * Priority: exact account number → exact full name → leaf-name match.
 * Returns the CoA id, or null when nothing matches confidently.
 */
export function matchGlToCoa(
  gl: { name: string; external_id?: string | null },
  accounts: CoaAccountRef[],
): string | null {
  const code = gl.external_id?.trim();
  if (code) {
    const byNumber = accounts.find((a) => a.account_number?.trim() === code);
    if (byNumber) return byNumber.id;
  }

  const glName = gl.name ? normName(gl.name) : "";
  if (!glName) return null;

  const byFull = accounts.find((a) => normName(a.account_name) === glName);
  if (byFull) return byFull.id;

  const glLeaf = leafName(gl.name);
  const byLeaf = accounts.filter((a) => leafName(a.account_name) === glLeaf);
  // Only trust a leaf match when it's unambiguous.
  if (byLeaf.length === 1) return byLeaf[0].id;

  return null;
}

export interface RuleRef {
  ramp_gl_id:           string;
  chart_of_accounts_id: string | null;
}

/**
 * Resolve the effective CoA + source for an expense given the current rule set.
 * Manual overrides are preserved. Otherwise the expense follows its GL account's
 * rule; an untagged expense (or a rule with no account) stays unmapped.
 */
export function resolveExpenseMapping(
  expense: { ramp_gl_id: string | null; mapping_source: MappingSource; chart_of_accounts_id: string | null },
  ruleByGlId: Map<string, RuleRef>,
): { chart_of_accounts_id: string | null; mapping_source: MappingSource } {
  if (expense.mapping_source === "manual") {
    return { chart_of_accounts_id: expense.chart_of_accounts_id, mapping_source: "manual" };
  }
  if (!expense.ramp_gl_id) {
    return { chart_of_accounts_id: null, mapping_source: "unmapped" };
  }
  const rule = ruleByGlId.get(expense.ramp_gl_id);
  if (rule?.chart_of_accounts_id) {
    return { chart_of_accounts_id: rule.chart_of_accounts_id, mapping_source: "rule" };
  }
  return { chart_of_accounts_id: null, mapping_source: "unmapped" };
}
