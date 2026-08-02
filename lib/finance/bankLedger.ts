/**
 * Bank-account ledger: classify each Ramp bank line into a flow_type that decides
 * (a) which table it lands in and (b) how statements treat it. This is the anti-
 * drift core — settlements (Vendor Payment, card payment, bill-matched Withdrawal)
 * are excluded so the underlying bill/card records aren't double-counted, and only
 * direct external debits become expenses. Anything unrecognized is `unclassified`
 * for review.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizeCounterparty, type RampBankLine } from "@/lib/ramp";
import { dollarsToCents, type ExpenseRecord } from "./expenses";
import { counterpartyRuleKey } from "./autoMap";
import { chunk } from "@/lib/utils/chunk";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export type FlowType =
  | "operating_expense"
  | "interest_income"
  | "internal_transfer"
  | "bill_settlement"
  | "card_settlement"
  | "deposit"
  | "unclassified";

export interface BankClassification {
  flow_type:         FlowType;
  affects_pl:        boolean;
  is_expense:        boolean;   // true ⇒ routes to `expenses`; else `ramp_bank_ledger`
  direction:         "inflow" | "outflow";
  counterparty_name: string;
  counterparty_key:  string;
}

/**
 * Bill totals (in cents) by fuzzy vendor key, for matching a plain "Withdrawal"
 * bank line against an already-recorded Ramp bill it pays off — e.g. a utility
 * paid by direct ACH autopay rather than Ramp's own Bill Pay ("Vendor Payment")
 * rail, which would otherwise double-count: once as the bill accrual, again as
 * the bank debit. A vendor can have several bills, hence a Set of totals.
 */
export type BillTotals = Map<string, Set<number>>;

/**
 * Alnum-only vendor key for bill-vs-bank matching: bank ACH descriptors mash
 * names together with no separators (e.g. "DUKEENERGY"), while Ramp's Bill
 * `vendor_name` is human-readable ("Duke Energy") — normalizeCounterparty's
 * whitespace-collapse alone leaves these unequal, so this strips punctuation
 * and spaces entirely. Combined with an exact-cents amount match, the risk of
 * an unrelated vendor colliding on both name and total-to-the-penny is low.
 */
export function billMatchKey(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Group bill line-item expense rows by their bill id (the part before the ":N"
 * suffix) and sum, keyed by fuzzy vendor.
 *
 * Each line is summed ONCE, keyed by its own source_transaction_id, because a
 * bill routinely arrives twice in a single sync: rampSync feeds this both the
 * bill lines already persisted in `expenses` (120-day lookback) and the bills
 * freshly fetched from the Ramp API. Adding a line twice yields a 2x bill total
 * that matches no real bank debit, silently regressing an already-excluded
 * settlement back into a live, double-counted expense.
 */
export function buildBillTotals(billLineItems: { source_transaction_id: string; amount_cents: number; merchant_name: string | null }[]): BillTotals {
  const linesByBillId = new Map<string, { centsByLineId: Map<string, number>; vendorKey: string }>();
  for (const row of billLineItems) {
    const billId = row.source_transaction_id.split(":")[0];
    const vendorKey = billMatchKey(row.merchant_name);
    const entry = linesByBillId.get(billId) ?? { centsByLineId: new Map<string, number>(), vendorKey };
    entry.centsByLineId.set(row.source_transaction_id, Math.abs(row.amount_cents));
    entry.vendorKey = vendorKey;
    linesByBillId.set(billId, entry);
  }

  const result: BillTotals = new Map();
  for (const { centsByLineId, vendorKey } of linesByBillId.values()) {
    if (!vendorKey) continue;
    let total = 0;
    for (const cents of centsByLineId.values()) total += cents;
    if (!result.has(vendorKey)) result.set(vendorKey, new Set());
    result.get(vendorKey)!.add(total);
  }
  return result;
}

export interface PruneCandidate {
  id:                    string;
  source_transaction_id: string;
  excluded_at:           string | null;
  /** 'manual' means a person pinned this row's account -- including pinning it at null. */
  mapping_source:        string | null;
  /** A person ticked "this doesn't need a GL mapping", which is the same kind of decision. */
  unmapped_accepted:     boolean | null;
}

/** A row kept for its coding but taken out of the statements. Both ids: one to update, one to report. */
export interface SetAsideCandidate {
  id:                    string;
  source_transaction_id: string;
}

/** Whether a person has said something about this row's GL coding, either by pinning an account or by accepting that it has none. */
function isCodedByHand(c: PruneCandidate): boolean {
  return c.mapping_source === "manual" || c.unmapped_accepted === true;
}

/**
 * Partition reclassified bank expenses three ways: safe to delete, to leave
 * alone, and to keep but take out of the statements.
 *
 * A row carrying manual work -- a GL split, a payroll match, or a manual
 * exclusion -- is never deleted. Both `expense_gl_splits.expense_id` and
 * `payroll_period_expense_matches.expense_id` reference `expenses(id)`, but only
 * the former cascades on delete (`on delete cascade`); the latter has NO `on
 * delete` clause (NO ACTION per supabase/migrations/20260714_payroll_gl_split.sql),
 * so deleting a matched expense doesn't silently orphan/cascade the match row --
 * it raises a foreign-key violation that fails the whole delete batch. Either
 * way the row must never be picked for deletion, so both tables feed the same
 * skip set.
 *
 * The third bucket resolves a genuine conflict. The feed now says this line is
 * not an expense at all, and its cash is already carried by the ramp_bank_ledger
 * row -- but a person coded it, and resolveExpenseMapping treats that pin as
 * authoritative over every rule (including a pin that deliberately points at
 * nothing). Deleting would discard the decision; keeping it live would
 * double-count the money the prune exists to de-duplicate. So the row is set
 * aside instead: excluded_at is stamped, which is exactly what a person does
 * from the Expenses tab when they find a duplicate, and which drops it from
 * every statement (lib/finance/financials/expenseFilters.ts) while leaving the
 * row, its account and its history intact and one click from being restored.
 * Split and payroll-matched rows stay in `skipped` rather than joining it --
 * app/api/finance/expenses/[id]/exclude/route.ts refuses to exclude those for
 * reasons that apply just as much to an automatic exclusion.
 */
export function selectPrunableExpenseIds(
  candidates: PruneCandidate[],
  expenseIdsWithManualWork: Set<string>,
): { deletable: string[]; skipped: string[]; setAside: SetAsideCandidate[] } {
  const deletable: string[] = [];
  const skipped:   string[] = [];
  const setAside:  SetAsideCandidate[] = [];
  for (const c of candidates) {
    if (expenseIdsWithManualWork.has(c.id) || c.excluded_at !== null) skipped.push(c.source_transaction_id);
    else if (isCodedByHand(c)) setAside.push({ id: c.id, source_transaction_id: c.source_transaction_id });
    else deletable.push(c.id);
  }
  return { deletable, skipped, setAside };
}

/** How each flow reads in a sentence. Exhaustive by type, so a new FlowType has to be given words here. */
const FLOW_TYPE_PHRASE: Record<FlowType, string> = {
  operating_expense: "an operating expense",
  interest_income:   "interest income",
  internal_transfer: "an internal transfer",
  bill_settlement:   "a bill settlement",
  card_settlement:   "a card statement payment",
  deposit:           "a deposit",
  unclassified:      "a bank flow, not an expense",
};

/** The sentence a bookkeeper reads on the excluded row, so the automatic decision explains itself. */
export function setAsideReason(flowType: FlowType | null): string {
  const what = flowType ? FLOW_TYPE_PHRASE[flowType] : FLOW_TYPE_PHRASE.unclassified;
  return `Ramp now reports this as ${what}, already recorded in the bank ledger. Set aside rather than deleted because it was coded by hand — include it again if that is wrong.`;
}

/** Whether a bank-ledger flow_type affects the P&L. In the ledger table only interest is income; transfers/settlements/deposits/unclassified are non-P&L. */
export function affectsPlForFlowType(flowType: FlowType): boolean {
  return flowType === "interest_income";
}

export function classifyBankLine(line: RampBankLine, ownAccounts: Set<string>, billTotals: BillTotals = new Map()): BankClassification {
  const desc    = line.description.trim();
  const destKey = normalizeCounterparty(line.destination_account_name);
  const srcKey  = normalizeCounterparty(line.source_account_name);
  const destOwn = destKey !== "" && ownAccounts.has(destKey);

  const make = (flow_type: FlowType, affects_pl: boolean, direction: "inflow" | "outflow", partyName: string): BankClassification => ({
    flow_type,
    affects_pl,
    is_expense: flow_type === "operating_expense",
    direction,
    counterparty_name: partyName,
    counterparty_key:  normalizeCounterparty(partyName),
  });

  if (desc === "Interest") return make("interest_income", true, "inflow", line.source_account_name ?? "Interest");
  if (desc === "Deposit")  return make("deposit", false, "inflow", line.source_account_name ?? "");
  if (desc === "Vendor Payment") return make("bill_settlement", false, "outflow", line.destination_account_name ?? "");

  if (desc === "Withdrawal") {
    const dest = line.destination_account_name ?? "";
    if (destKey === "") return make("unclassified", false, "outflow", "");
    if (destOwn) return make("internal_transfer", false, "outflow", dest);
    // A vendor paid by direct ACH autopay (not routed through Ramp Bill Pay)
    // shows up here as a plain Withdrawal, not "Vendor Payment" — match it
    // against a recorded bill's total so it's excluded like any other
    // settlement instead of double-booked as a second, separate expense.
    if (billTotals.get(billMatchKey(dest))?.has(dollarsToCents(line.amount))) {
      return make("bill_settlement", false, "outflow", dest);
    }
    // Otherwise a Withdrawal to an external party is a direct operating-expense
    // debit (Gusto, Erie, tax). Card statement settlements never appear in this
    // feed — they are ingested authoritatively from /transfers (see transferLedger).
    return make("operating_expense", true, "outflow", dest);
  }

  // Unknown description — surface for manual review, never auto-book.
  return make("unclassified", false, srcKey && !ownAccounts.has(srcKey) ? "inflow" : "outflow", line.destination_account_name ?? line.source_account_name ?? "");
}

export interface BankLedgerRecord {
  source:                   "ramp";
  source_transaction_id:    string;
  amount_cents:             number;
  currency_code:            string;
  description:              string | null;
  counterparty_name:        string | null;
  counterparty_key:         string | null;
  source_account_name:      string | null;
  destination_account_name: string | null;
  flow_type:                FlowType;
  affects_pl:               boolean;
  transaction_date:         string | null;
  qb_sync_status:           string | null;   // raw Ramp QB sync_status for the bank line
  qb_synced_at:             string | null;   // always null for bank lines (Ramp exposes no per-line synced_at)
  qb_remote_id:             string | null;   // always null for bank lines
}

/** Signed cents from an unsigned magnitude + direction. */
function signedCents(amount: number, direction: "inflow" | "outflow"): number {
  const cents = dollarsToCents(amount);
  return direction === "outflow" ? -cents : cents;
}

function bankLineToExpenseRecord(line: RampBankLine, c: BankClassification): ExpenseRecord {
  return {
    source:                "ramp",
    ramp_object:           "bank",
    source_transaction_id: line.id,
    amount_cents:          signedCents(line.amount, c.direction),
    currency_code:         line.currency_code || "USD",
    memo:                  line.description || null,
    merchant_name:         c.counterparty_name || null,
    merchant_category:     null,
    sk_category_name:      null,
    // A bank line only lands here once it has posted to the account, so it is settled
    // by definition — surface it as "cleared" (green) alongside card/bill statuses.
    state:                 "cleared",
    card_holder_name:      null,
    department_name:       null,
    transaction_time:      line.date || null,
    accounting_date:       line.date ? line.date.slice(0, 10) : null,
    external_account_id:   null,
    external_account_name: null,
    external_account_code: null,
    counterparty_key:      c.counterparty_key || null,
    counterparty_label:    c.counterparty_name || null,
    qb_sync_status:        line.sync_status,
    qb_synced_at:          null,
    qb_remote_id:          null,
  };
}

function bankLineToLedgerRecord(line: RampBankLine, c: BankClassification): BankLedgerRecord {
  return {
    source:                   "ramp",
    source_transaction_id:    line.id,
    amount_cents:             signedCents(line.amount, c.direction),
    currency_code:            line.currency_code || "USD",
    description:              line.description || null,
    counterparty_name:        c.counterparty_name || null,
    counterparty_key:         c.counterparty_key || null,
    source_account_name:      line.source_account_name,
    destination_account_name: line.destination_account_name,
    flow_type:                c.flow_type,
    affects_pl:               c.affects_pl,
    transaction_date:         line.date ? line.date.slice(0, 10) : null,
    qb_sync_status:           line.sync_status,
    qb_synced_at:             null,
    qb_remote_id:             null,
  };
}

/** Classify every bank line and split into expense-bound vs ledger-bound records. */
export function partitionBankLines(
  lines: RampBankLine[],
  ownAccounts: Set<string>,
  billTotals: BillTotals = new Map(),
): { expenseRecords: ExpenseRecord[]; ledgerRecords: BankLedgerRecord[] } {
  const expenseRecords: ExpenseRecord[] = [];
  const ledgerRecords:  BankLedgerRecord[] = [];
  for (const line of lines) {
    const c = classifyBankLine(line, ownAccounts, billTotals);
    if (c.is_expense) expenseRecords.push(bankLineToExpenseRecord(line, c));
    else              ledgerRecords.push(bankLineToLedgerRecord(line, c));
  }
  return { expenseRecords, ledgerRecords };
}


export async function syncBankLedger(
  supabase: AdminClient,
  records: BankLedgerRecord[],
): Promise<{ imported: number; by_flow_type: Record<string, number> }> {
  // Preserve manual coding — AND a manual flow_type recode — across re-syncs.
  const existing = new Map<string, { mapping_source: string; chart_of_accounts_id: string | null; flow_type: FlowType; affects_pl: boolean }>();
  for (const ids of chunk(records.map((r) => r.source_transaction_id), 500)) {
    const { data, error } = await supabase
      .from("ramp_bank_ledger")
      .select("source_transaction_id, mapping_source, chart_of_accounts_id, flow_type, affects_pl")
      .eq("source", "ramp")
      .in("source_transaction_id", ids);
    if (error) throw new Error(`Load bank ledger failed: ${error.message}`);
    for (const e of data ?? []) {
      existing.set(e.source_transaction_id, {
        mapping_source: e.mapping_source,
        chart_of_accounts_id: e.chart_of_accounts_id,
        flow_type: e.flow_type,
        affects_pl: e.affects_pl,
      });
    }
  }

  // Counterparty rules — the same table bank-sourced expenses resolve against.
  // Keyed by (feed, counterparty) rather than counterparty alone: the rule table
  // is unique on that pair, so "GUSTO on the Ramp account" and "GUSTO on the
  // Chase account" are two rules with two accounts. Every record here is Ramp's,
  // so this is the same lookup it always was — but the key now says why.
  const { data: cpRuleRows, error: cpRuleErr } = await supabase
    .from("expense_counterparty_mappings")
    .select("source, counterparty_key, chart_of_accounts_id")
    .not("chart_of_accounts_id", "is", null);
  if (cpRuleErr) throw new Error(`Load counterparty mappings failed: ${cpRuleErr.message}`);
  const coaByCounterparty = new Map<string, string>(
    (cpRuleRows ?? []).map((r) => [counterpartyRuleKey(r.source as string, r.counterparty_key as string), r.chart_of_accounts_id as string]),
  );

  const syncedAt = new Date().toISOString();
  const by_flow_type: Record<string, number> = {};
  const rows = records.map((rec) => {
    const prior = existing.get(rec.source_transaction_id);
    const manual = prior?.mapping_source === "manual";
    const flow_type  = manual ? prior!.flow_type  : rec.flow_type;
    const affects_pl = manual ? prior!.affects_pl : rec.affects_pl;
    by_flow_type[flow_type] = (by_flow_type[flow_type] ?? 0) + 1;

    // Fill-nulls-only: manual pin wins; else a prior rule/manual account survives
    // re-sync; else resolve fresh from a counterparty rule; else unmapped.
    let chart_of_accounts_id: string | null;
    let mapping_source: string;
    if (manual) {
      chart_of_accounts_id = prior!.chart_of_accounts_id;
      mapping_source = "manual";
    } else if (prior?.chart_of_accounts_id) {
      chart_of_accounts_id = prior.chart_of_accounts_id;
      mapping_source = prior.mapping_source;
    } else {
      const ruleCoa = rec.counterparty_key ? coaByCounterparty.get(counterpartyRuleKey(rec.source, rec.counterparty_key)) ?? null : null;
      chart_of_accounts_id = ruleCoa;
      mapping_source = ruleCoa ? "rule" : "unmapped";
    }
    return { ...rec, flow_type, affects_pl, chart_of_accounts_id, mapping_source, synced_at: syncedAt };
  });

  for (const batch of chunk(rows, 500)) {
    const { error } = await supabase.from("ramp_bank_ledger").upsert(batch, { onConflict: "source,source_transaction_id" });
    if (error) throw new Error(`Upsert bank ledger failed: ${error.message}`);
  }
  return { imported: records.length, by_flow_type };
}
