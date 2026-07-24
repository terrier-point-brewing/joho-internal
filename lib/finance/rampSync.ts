/**
 * One place that pulls every Ramp money-movement object for a window and lands it
 * in the ledger: card txns + bills + operating-expense bank debits → `expenses`
 * (one syncExpenseRecords call so GL + counterparty rules resolve together); all
 * other bank lines + Business-Account transfers (card statement payments) →
 * `ramp_bank_ledger`. Reused by the on-demand route, the daily cron, and the
 * webhook re-sync.
 */
import { getRampTransactions, getRampBills, getRampBankTransactions, getRampBankAccounts, getRampTransfers, getRampStatements, normalizeCounterparty } from "@/lib/ramp";
import { rampTxnToExpenseRecord, rampBillToExpenseRecords, syncExpenseRecords } from "./rampExpenses";
import { partitionBankLines, syncBankLedger, buildBillTotals, selectPrunableExpenseIds, type PruneCandidate } from "./bankLedger";
import { classifyTransfers, transferToLedgerRecord } from "./transferLedger";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { chunk } from "@/lib/utils/chunk";

// How far back to look for a bill a Withdrawal might be settling. Deliberately
// independent of the caller's own from/to window (the daily cron looks back 45
// days, the webhook resync only 2) so a bill-vs-payment match is stable
// regardless of which sync path runs — a narrower window must never regress an
// already-excluded settlement back into a live, double-counted expense.
const BILL_MATCH_LOOKBACK_DAYS = 120;

export async function syncAllRamp(supabase: ReturnType<typeof createSupabaseAdminClient>, from?: string, to?: string) {
  const [txns, bills, bankLines, bankAccounts, transfers, statements] = await Promise.all([
    getRampTransactions(from, to), getRampBills(from, to), getRampBankTransactions(from, to), getRampBankAccounts(),
    getRampTransfers(from, to), getRampStatements(),
  ]);
  const ownAccounts = new Set(bankAccounts.map((a) => normalizeCounterparty(a.name)));

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - BILL_MATCH_LOOKBACK_DAYS);
  const { data: histBillRows, error: histBillErr } = await supabase
    .from("expenses")
    .select("source_transaction_id, amount_cents, merchant_name")
    .eq("source", "ramp").eq("ramp_object", "bill")
    .gte("accounting_date", cutoff.toISOString().slice(0, 10));
  if (histBillErr) throw new Error(`Load bill totals failed: ${histBillErr.message}`);
  const billTotals = buildBillTotals([...(histBillRows ?? []), ...bills.flatMap(rampBillToExpenseRecords)]);

  const { expenseRecords, ledgerRecords } = partitionBankLines(bankLines, ownAccounts, billTotals);

  // Business-Account transfers (card statement autopayments) → ledger, reconciled
  // against statement charges. Non-P&L: their card charges are already booked.
  const transferRecords = classifyTransfers(transfers, statements)
    .map(({ transfer, flow_type }) => transferToLedgerRecord(transfer, flow_type));

  const records = [...txns.map(rampTxnToExpenseRecord), ...bills.flatMap(rampBillToExpenseRecords), ...expenseRecords];
  const expenses = await syncExpenseRecords(supabase, records);
  const bank = await syncBankLedger(supabase, [...ledgerRecords, ...transferRecords]);
  // After the upsert, not before: a line that moved from expenses to the ledger
  // is absent from `records`, so its stale expenses row can only go away here.
  const pruned = await pruneReclassifiedBankExpenses(supabase, ledgerRecords.map((r) => r.source_transaction_id));
  return { ...expenses, bank, pruned };
}

/**
 * Delete `expenses` rows for bank lines that now classify as non-expense ledger
 * flows. syncExpenseRecords only upserts what it is handed and never prunes, so
 * a line that used to be an operating_expense and is now (say) a bill_settlement
 * would otherwise persist forever as a phantom second expense -- the Duke Energy
 * double-count. Rows carrying manual work are skipped, not deleted.
 */
export async function pruneReclassifiedBankExpenses(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  ledgerSourceIds: string[],
): Promise<{ deleted: number; skipped: string[] }> {
  let deleted = 0;
  const skipped: string[] = [];

  for (const ids of chunk(ledgerSourceIds, 500)) {
    const { data: candidates, error: candErr } = await supabase
      .from("expenses")
      .select("id, source_transaction_id, excluded_at")
      .eq("source", "ramp").eq("ramp_object", "bank")
      .in("source_transaction_id", ids);
    if (candErr) throw new Error(`Load reclassified bank expenses failed: ${candErr.message}`);
    if (!candidates || candidates.length === 0) continue;

    const { data: splitRows, error: splitErr } = await supabase
      .from("expense_gl_splits")
      .select("expense_id")
      .in("expense_id", candidates.map((c) => c.id as string));
    if (splitErr) throw new Error(`Load splits for reclassified bank expenses failed: ${splitErr.message}`);

    const withSplits = new Set((splitRows ?? []).map((r) => r.expense_id as string));
    const picked = selectPrunableExpenseIds(candidates as PruneCandidate[], withSplits);
    skipped.push(...picked.skipped);
    if (picked.deletable.length === 0) continue;

    const { error: delErr } = await supabase.from("expenses").delete().in("id", picked.deletable);
    if (delErr) throw new Error(`Prune reclassified bank expenses failed: ${delErr.message}`);
    deleted += picked.deletable.length;
  }

  return { deleted, skipped };
}
