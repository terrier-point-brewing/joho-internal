/**
 * Ramp source adapter + sync. Converts Ramp transactions into source-agnostic
 * ExpenseRecords, ensures a GL→CoA rule exists for every Ramp GL account seen
 * (auto-matching against the chart of accounts), and resolves each expense's
 * account from those rules — while never disturbing manual per-expense pins.
 *
 * The pure mapping decisions live in ./expenses (unit-tested separately); the
 * IO (Supabase reads/writes) lives here.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { RampTransaction, RampBill } from "@/lib/ramp";
import { extractGlAccount } from "@/lib/ramp";
import { chunk } from "@/lib/utils/chunk";
import {
  dollarsToCents,
  matchAccountToCoa,
  resolveExpenseMapping,
  type ExpenseRecord,
  type CoaAccountRef,
  type RuleRef,
  type CounterpartyRuleRef,
  type MappingSource,
} from "./expenses";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** All expenses imported by this adapter carry source = 'ramp'. */
const SOURCE = "ramp" as const;

/**
 * `expenses.state` is upper-case-only (CHECK `expenses_state_upper_check`) so the
 * statements can match it with .eq() — mixed casing here once silently dropped
 * every bank/payroll row off the cash-flow statement. Ramp already sends upper-
 * case for the values we've seen, but nothing upstream validates that (lib/ramp.ts
 * passes `state`/`status` straight through), so fold it here rather than trust it.
 * Ramp's absent-value sentinel is "", which becomes null.
 */
function normalizeState(raw: string | null | undefined): string | null {
  return raw ? raw.toUpperCase() : null;
}

export interface RampSyncResult {
  imported:           number;
  mapped:             number;
  unmapped:           number;
  new_rules:          number;
  auto_matched_rules: number;
}

/** Shape a raw Ramp transaction into a clean, source-agnostic expense record. */
export function rampTxnToExpenseRecord(txn: RampTransaction): ExpenseRecord {
  const holder = [txn.card_holder.first_name, txn.card_holder.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    source:                SOURCE,
    ramp_object:           "card",
    source_transaction_id: txn.id,
    amount_cents:          -dollarsToCents(txn.amount),   // outflow negative
    currency_code:         txn.currency_code || "USD",
    memo:                  txn.memo || null,
    merchant_name:         txn.merchant_name || null,
    merchant_category:     txn.merchant_category_code_description || null,
    sk_category_name:      txn.sk_category_name || null,
    state:                 normalizeState(txn.state),
    card_holder_name:      holder || null,
    department_name:       txn.card_holder.department_name || null,
    transaction_time:      txn.user_transaction_time || null,
    accounting_date:       txn.accounting_date ? txn.accounting_date.slice(0, 10) : null,
    external_account_id:   txn.gl_account?.id ?? null,
    external_account_name: txn.gl_account?.name ?? null,
    external_account_code: txn.gl_account?.external_id ?? null,
    counterparty_key:      null,
    counterparty_label:    null,
    qb_sync_status:        txn.sync_status,
    qb_synced_at:          txn.qb_synced_at,
    qb_remote_id:          null,
  };
}

/**
 * Shape a Ramp bill into one ExpenseRecord PER LINE ITEM. Bills carry GL coding
 * per line and may split one invoice across accounts, so line-item grain keeps
 * statements accurate. source_transaction_id namespaces the line index under the
 * bill id so re-syncs upsert idempotently. A bill with no line items yields a
 * single uncoded record for the whole total.
 */
export function rampBillToExpenseRecords(bill: RampBill): ExpenseRecord[] {
  const day = bill.accounting_date ? bill.accounting_date.slice(0, 10) : null;

  const base = {
    source:             SOURCE,
    ramp_object:        "bill" as const,
    currency_code:      bill.currency_code || "USD",
    merchant_name:      bill.vendor_name || null,
    merchant_category:  null,
    sk_category_name:   null,
    state:              normalizeState(bill.status),
    card_holder_name:   null,
    department_name:    null,
    transaction_time:   bill.issued_at || null,
    accounting_date:    day,
    // Written on every line of every bill, every sync, including as null. A
    // bill that is paid, or whose payment is reversed, has to carry that
    // through the upsert -- leaving the old value would strand a settled bill
    // in accounts payable, or worse, leave a re-opened one out of it.
    settled_at:         bill.paid_at || null,
    counterparty_key:   null,
    counterparty_label: null,
    // Every line item of a bill shares the bill's QB sync state + remote id.
    qb_sync_status:     bill.sync_status,
    qb_synced_at:       null,
    qb_remote_id:       bill.remote_id,
  };

  if (bill.line_items.length === 0) {
    return [{
      ...base,
      source_transaction_id: `${bill.id}:0`,
      amount_cents:          -dollarsToCents(bill.amount),
      memo:                  bill.memo,
      external_account_id:   null,
      external_account_name: null,
      external_account_code: null,
    }];
  }

  return bill.line_items.map((li, i) => {
    const gl = extractGlAccount({ accounting_field_selections: li.accounting_field_selections });
    return {
      ...base,
      source_transaction_id: `${bill.id}:${i}`,
      amount_cents:          -dollarsToCents(li.amount),
      memo:                  li.memo ?? bill.memo,
      external_account_id:   gl?.id ?? null,
      external_account_name: gl?.name ?? null,
      external_account_code: gl?.external_id ?? null,
    };
  });
}


/**
 * The `expenses` columns of an ExpenseRecord. The account's name and code are
 * NOT among them: both describe the ACCOUNT rather than the transaction, so
 * they live once on expense_account_mappings (keyed source +
 * external_account_id) instead of being copied onto every row. Readers derive
 * the name from there; the code is consumed during the sync itself
 * (matchAccountToCoa) and never needed again.
 */
export function toExpenseRow(rec: ExpenseRecord): Omit<ExpenseRecord, "external_account_name" | "external_account_code"> {
  const row: Partial<ExpenseRecord> = { ...rec };
  delete row.external_account_name;
  delete row.external_account_code;
  return row as Omit<ExpenseRecord, "external_account_name" | "external_account_code">;
}

/**
 * Bring the settlement state of ALREADY-STORED bill rows up to date: whether the
 * bill is still open, and when it was paid.
 *
 * ── Why this exists at all ───────────────────────────────────────────────────
 * A bill is incurred in one month and paid in another, and the payment is
 * frequently outside whatever window the caller asked to sync (the daily cron
 * looks back 45 days; the webhook re-sync, two). Without this, a bill synced in
 * June and paid in August keeps June's `state = 'OPEN'` and a null `settled_at`
 * forever, and accounts payable goes on reporting a debt that was settled --
 * growing, never shrinking, which is precisely the failure GL 2310 shipped with.
 *
 * ── Why it updates rather than re-upserting ──────────────────────────────────
 * The obvious alternative is to hand every bill to syncExpenseRecords and let
 * the upsert carry the new state. That would also re-run GL and counterparty
 * resolution over bills nobody asked about, and re-insert rows for bills that
 * were deliberately pruned or set aside. This touches two columns and creates
 * nothing, so a bill's coding, exclusion and splits are all left exactly as they
 * were. Rows for bills that are not stored simply match nothing.
 *
 * Best-effort by contract: callers catch. A settlement refresh failing must
 * never take down the sync that carried the actual money movements.
 */
export async function refreshBillSettlement(
  supabase: AdminClient,
  bills: RampBill[],
): Promise<{ refreshed: number }> {
  let refreshed = 0;
  for (const bill of bills) {
    // Line-item grain: source_transaction_id is `${bill.id}:${lineIndex}`, so
    // one bill owns every row under its id prefix. Anchored with the colon so
    // one bill id can never prefix-match another's.
    const { error, count } = await supabase
      .from("expenses")
      .update(
        { state: normalizeState(bill.status), settled_at: bill.paid_at || null },
        { count: "exact" },
      )
      .eq("source", SOURCE)
      .eq("ramp_object", "bill")
      .like("source_transaction_id", `${bill.id}:%`);
    if (error) throw new Error(`Refresh bill settlement failed: ${error.message}`);
    refreshed += count ?? 0;
  }
  return { refreshed };
}

export async function syncExpenseRecords(
  supabase: AdminClient,
  records: ExpenseRecord[],
): Promise<RampSyncResult> {
  // Chart of accounts — for auto-matching new external accounts.
  const { data: accountRows, error: coaErr } = await supabase
    .from("chart_of_accounts")
    .select("id, account_name, account_number");
  if (coaErr) throw new Error(`Load chart of accounts failed: ${coaErr.message}`);
  const coa = (accountRows ?? []) as CoaAccountRef[];

  // Existing rules for this source. The name comes back too: since `expenses`
  // no longer stores its own copy, this row is the only place the account's
  // display name lives, so the sync has to keep it current (below).
  const { data: ruleRows, error: ruleErr } = await supabase
    .from("expense_account_mappings")
    .select("external_account_id, external_account_name, chart_of_accounts_id")
    .eq("source", SOURCE);
  if (ruleErr) throw new Error(`Load expense mappings failed: ${ruleErr.message}`);

  const ruleByAccountId = new Map<string, RuleRef>();
  const ruleNameByAccountId = new Map<string, string | null>();
  for (const r of ruleRows ?? []) {
    ruleByAccountId.set(r.external_account_id, { external_account_id: r.external_account_id, chart_of_accounts_id: r.chart_of_accounts_id });
    ruleNameByAccountId.set(r.external_account_id, r.external_account_name);
  }

  // Create a rule for every external account in this batch we haven't seen
  // before, auto-matching it to the chart of accounts where we can.
  const distinct = new Map<string, { name: string; code: string | null }>();
  for (const rec of records) {
    if (rec.external_account_id && !distinct.has(rec.external_account_id)) {
      distinct.set(rec.external_account_id, { name: rec.external_account_name ?? "", code: rec.external_account_code });
    }
  }

  const newRules: {
    source: string;
    external_account_id: string;
    external_account_name: string;
    external_account_code: string | null;
    chart_of_accounts_id: string | null;
    auto_matched: boolean;
  }[] = [];
  let autoMatched = 0;

  for (const [accountId, ext] of distinct) {
    if (ruleByAccountId.has(accountId)) continue;
    const coaId = matchAccountToCoa({ name: ext.name, code: ext.code }, coa);
    if (coaId) autoMatched++;
    newRules.push({
      source:                SOURCE,
      external_account_id:   accountId,
      external_account_name: ext.name,
      external_account_code: ext.code,
      chart_of_accounts_id:  coaId,
      auto_matched:          true,
    });
    ruleByAccountId.set(accountId, { external_account_id: accountId, chart_of_accounts_id: coaId });
  }

  if (newRules.length > 0) {
    const { error } = await supabase
      .from("expense_account_mappings")
      .upsert(newRules, { onConflict: "source,external_account_id" });
    if (error) throw new Error(`Insert expense mappings failed: ${error.message}`);
  }

  // Ramp can rename a GL account after we first recorded it. `expenses` used to
  // carry its own copy of the name, re-written on every sync, so a rename showed
  // up on the Transactions screen immediately. Now that the name is derived from
  // this row, refresh it here or the screen would freeze on whatever the account
  // was called the day it first appeared. Only the name: the code column on this
  // table is Ramp's own account id, which is a different value from anything
  // `expenses` ever stored, and no sync should quietly rewrite it.
  const renamed = [...distinct.entries()].filter(([accountId, ext]) => {
    if (!ext.name) return false;
    const known = ruleNameByAccountId.get(accountId);
    return known !== undefined && known !== ext.name;
  });
  for (const [accountId, ext] of renamed) {
    const { error } = await supabase
      .from("expense_account_mappings")
      .update({ external_account_name: ext.name })
      .eq("source", SOURCE)
      .eq("external_account_id", accountId);
    if (error) throw new Error(`Refresh expense mapping name failed: ${error.message}`);
  }

  // Counterparty rules (for bank-sourced rows with no GL coding).
  const { data: cpRows, error: cpErr } = await supabase
    .from("expense_counterparty_mappings")
    .select("counterparty_key, chart_of_accounts_id, routing")
    .eq("source", SOURCE);
  if (cpErr) throw new Error(`Load counterparty mappings failed: ${cpErr.message}`);

  const ruleByCounterparty = new Map<string, CounterpartyRuleRef>();
  for (const r of cpRows ?? []) {
    ruleByCounterparty.set(r.counterparty_key, { counterparty_key: r.counterparty_key, chart_of_accounts_id: r.chart_of_accounts_id, routing: r.routing });
  }

  // Ensure a rule row exists for every counterparty in this batch (unmapped —
  // counterparties don't name-match the CoA, so the user assigns in Settings).
  const newCpRules: { source: string; counterparty_key: string; counterparty_label: string; chart_of_accounts_id: null; auto_matched: boolean }[] = [];
  for (const rec of records) {
    if (rec.counterparty_key && !ruleByCounterparty.has(rec.counterparty_key)) {
      ruleByCounterparty.set(rec.counterparty_key, { counterparty_key: rec.counterparty_key, chart_of_accounts_id: null, routing: "single_account" });
      newCpRules.push({ source: SOURCE, counterparty_key: rec.counterparty_key, counterparty_label: rec.counterparty_label ?? rec.counterparty_key, chart_of_accounts_id: null, auto_matched: false });
    }
  }
  if (newCpRules.length > 0) {
    const { error } = await supabase
      .from("expense_counterparty_mappings")
      .upsert(newCpRules, { onConflict: "source,counterparty_key" });
    if (error) throw new Error(`Insert counterparty mappings failed: ${error.message}`);
  }

  // Preserve manual per-expense overrides across re-syncs.
  const existing = new Map<string, { mapping_source: MappingSource; chart_of_accounts_id: string | null }>();
  for (const ids of chunk(records.map((r) => r.source_transaction_id), 500)) {
    const { data, error } = await supabase
      .from("expenses")
      .select("source_transaction_id, mapping_source, chart_of_accounts_id, counterparty_key")
      .eq("source", SOURCE)
      .in("source_transaction_id", ids);
    if (error) throw new Error(`Load existing expenses failed: ${error.message}`);
    for (const e of data ?? []) {
      existing.set(e.source_transaction_id, { mapping_source: e.mapping_source, chart_of_accounts_id: e.chart_of_accounts_id });
    }
  }

  const syncedAt = new Date().toISOString();
  let mapped = 0;
  let unmapped = 0;

  const upsertRows = records.map((rec) => {
    const prior = existing.get(rec.source_transaction_id);
    const resolved = resolveExpenseMapping(
      {
        external_account_id:  rec.external_account_id,
        counterparty_key:     rec.counterparty_key,
        mapping_source:       prior?.mapping_source ?? "unmapped",
        chart_of_accounts_id: prior?.chart_of_accounts_id ?? null,
      },
      ruleByAccountId,
      ruleByCounterparty,
    );
    if (resolved.chart_of_accounts_id) mapped++;
    else unmapped++;
    return {
      ...toExpenseRow(rec),
      chart_of_accounts_id: resolved.chart_of_accounts_id,
      mapping_source:       resolved.mapping_source,
      synced_at:            syncedAt,
    };
  });

  for (const rows of chunk(upsertRows, 500)) {
    const { error } = await supabase
      .from("expenses")
      .upsert(rows, { onConflict: "source,source_transaction_id" });
    if (error) throw new Error(`Upsert expenses failed: ${error.message}`);
  }

  return {
    imported:           records.length,
    mapped,
    unmapped,
    new_rules:          newRules.length,
    auto_matched_rules: autoMatched,
  };
}

/** Back-compat: sync a batch of Ramp card transactions. */
export async function syncRampExpenses(
  supabase: AdminClient,
  txns: RampTransaction[],
): Promise<RampSyncResult> {
  return syncExpenseRecords(supabase, txns.map(rampTxnToExpenseRecord));
}
