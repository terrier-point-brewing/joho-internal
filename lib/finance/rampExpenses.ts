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
import {
  dollarsToCents,
  matchAccountToCoa,
  resolveExpenseMapping,
  type ExpenseRecord,
  type CoaAccountRef,
  type RuleRef,
  type MappingSource,
} from "./expenses";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** All expenses imported by this adapter carry source = 'ramp'. */
const SOURCE = "ramp" as const;

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
    state:                 txn.state || null,
    card_holder_name:      holder || null,
    department_name:       txn.card_holder.department_name || null,
    transaction_time:      txn.user_transaction_time || null,
    accounting_date:       txn.accounting_date ? txn.accounting_date.slice(0, 10) : null,
    external_account_id:   txn.gl_account?.id ?? null,
    external_account_name: txn.gl_account?.name ?? null,
    external_account_code: txn.gl_account?.external_id ?? null,
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
    source:            SOURCE,
    ramp_object:       "bill" as const,
    currency_code:     bill.currency_code || "USD",
    merchant_name:     bill.vendor_name || null,
    merchant_category: null,
    sk_category_name:  null,
    state:             bill.status || null,
    card_holder_name:  null,
    department_name:   null,
    transaction_time:  bill.issued_at || null,
    accounting_date:   day,
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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

  // Existing rules for this source.
  const { data: ruleRows, error: ruleErr } = await supabase
    .from("expense_account_mappings")
    .select("external_account_id, chart_of_accounts_id")
    .eq("source", SOURCE);
  if (ruleErr) throw new Error(`Load expense mappings failed: ${ruleErr.message}`);

  const ruleByAccountId = new Map<string, RuleRef>();
  for (const r of ruleRows ?? []) {
    ruleByAccountId.set(r.external_account_id, { external_account_id: r.external_account_id, chart_of_accounts_id: r.chart_of_accounts_id });
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

  // Preserve manual per-expense overrides across re-syncs.
  const existing = new Map<string, { mapping_source: MappingSource; chart_of_accounts_id: string | null }>();
  for (const ids of chunk(records.map((r) => r.source_transaction_id), 500)) {
    const { data } = await supabase
      .from("expenses")
      .select("source_transaction_id, mapping_source, chart_of_accounts_id")
      .eq("source", SOURCE)
      .in("source_transaction_id", ids);
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
        mapping_source:       prior?.mapping_source ?? "unmapped",
        chart_of_accounts_id: prior?.chart_of_accounts_id ?? null,
      },
      ruleByAccountId,
    );
    if (resolved.chart_of_accounts_id) mapped++;
    else unmapped++;
    return {
      ...rec,
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
