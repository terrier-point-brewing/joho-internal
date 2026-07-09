/**
 * Bank-account ledger: classify each Ramp bank line into a flow_type that decides
 * (a) which table it lands in and (b) how statements treat it. This is the anti-
 * drift core — settlements (Vendor Payment, card payment) are excluded so the
 * underlying bill/card records aren't double-counted, and only direct external
 * debits become expenses. Anything unrecognized is `unclassified` for review.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizeCounterparty, type RampBankLine } from "@/lib/ramp";
import { dollarsToCents, type ExpenseRecord } from "./expenses";
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

/** Whether a bank-ledger flow_type affects the P&L. In the ledger table only interest is income; transfers/settlements/deposits/unclassified are non-P&L. */
export function affectsPlForFlowType(flowType: FlowType): boolean {
  return flowType === "interest_income";
}

export function classifyBankLine(line: RampBankLine, ownAccounts: Set<string>): BankClassification {
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
    // A Withdrawal to an external party is a direct operating-expense debit
    // (Gusto, Erie, tax). Card statement settlements never appear in this feed —
    // they are ingested authoritatively from /transfers (see transferLedger).
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
  source_account_name:      string | null;
  destination_account_name: string | null;
  flow_type:                FlowType;
  affects_pl:               boolean;
  transaction_date:         string | null;
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
    state:                 null,
    card_holder_name:      null,
    department_name:       null,
    transaction_time:      line.date || null,
    accounting_date:       line.date ? line.date.slice(0, 10) : null,
    external_account_id:   null,
    external_account_name: null,
    external_account_code: null,
    counterparty_key:      c.counterparty_key || null,
    counterparty_label:    c.counterparty_name || null,
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
    source_account_name:      line.source_account_name,
    destination_account_name: line.destination_account_name,
    flow_type:                c.flow_type,
    affects_pl:               c.affects_pl,
    transaction_date:         line.date ? line.date.slice(0, 10) : null,
  };
}

/** Classify every bank line and split into expense-bound vs ledger-bound records. */
export function partitionBankLines(
  lines: RampBankLine[],
  ownAccounts: Set<string>,
): { expenseRecords: ExpenseRecord[]; ledgerRecords: BankLedgerRecord[] } {
  const expenseRecords: ExpenseRecord[] = [];
  const ledgerRecords:  BankLedgerRecord[] = [];
  for (const line of lines) {
    const c = classifyBankLine(line, ownAccounts);
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

  const syncedAt = new Date().toISOString();
  const by_flow_type: Record<string, number> = {};
  const rows = records.map((rec) => {
    const prior = existing.get(rec.source_transaction_id);
    const manual = prior?.mapping_source === "manual";
    const flow_type  = manual ? prior!.flow_type  : rec.flow_type;
    const affects_pl = manual ? prior!.affects_pl : rec.affects_pl;
    by_flow_type[flow_type] = (by_flow_type[flow_type] ?? 0) + 1;
    return {
      ...rec,
      flow_type,
      affects_pl,
      chart_of_accounts_id: manual ? prior!.chart_of_accounts_id : null,
      mapping_source:       manual ? "manual" : "unmapped",
      synced_at:            syncedAt,
    };
  });

  for (const batch of chunk(rows, 500)) {
    const { error } = await supabase.from("ramp_bank_ledger").upsert(batch, { onConflict: "source,source_transaction_id" });
    if (error) throw new Error(`Upsert bank ledger failed: ${error.message}`);
  }
  return { imported: records.length, by_flow_type };
}
