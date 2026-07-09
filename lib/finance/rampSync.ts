/**
 * One place that pulls every Ramp money-movement object for a window and lands it
 * in the ledger: card txns + bills + operating-expense bank debits → `expenses`
 * (one syncExpenseRecords call so GL + counterparty rules resolve together); all
 * other bank lines → `ramp_bank_ledger`. Reused by the on-demand route, the daily
 * cron, and the webhook re-sync.
 */
import { getRampTransactions, getRampBills, getRampBankTransactions, getRampBankAccounts, normalizeCounterparty } from "@/lib/ramp";
import { rampTxnToExpenseRecord, rampBillToExpenseRecords, syncExpenseRecords } from "./rampExpenses";
import { partitionBankLines, syncBankLedger } from "./bankLedger";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function syncAllRamp(supabase: ReturnType<typeof createSupabaseAdminClient>, from?: string, to?: string) {
  const [txns, bills, bankLines, bankAccounts] = await Promise.all([
    getRampTransactions(from, to), getRampBills(from, to), getRampBankTransactions(from, to), getRampBankAccounts(),
  ]);
  const ownAccounts = new Set(bankAccounts.map((a) => normalizeCounterparty(a.name)));
  const { expenseRecords, ledgerRecords } = partitionBankLines(bankLines, ownAccounts);

  const records = [...txns.map(rampTxnToExpenseRecord), ...bills.flatMap(rampBillToExpenseRecords), ...expenseRecords];
  const expenses = await syncExpenseRecords(supabase, records);
  const bank = await syncBankLedger(supabase, ledgerRecords);
  return { ...expenses, bank };
}
