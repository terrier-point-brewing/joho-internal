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
import { partitionBankLines, syncBankLedger, buildBillTotals } from "./bankLedger";
import { classifyTransfers, transferToLedgerRecord } from "./transferLedger";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

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
  return { ...expenses, bank };
}
