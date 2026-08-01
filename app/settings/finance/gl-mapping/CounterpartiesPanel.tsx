"use client";
/**
 * Counterparty rules (uncoded bank-line senders/payees, e.g. Gusto, Erie) →
 * Chart of Accounts. Rows seed themselves the first time a bank line from that
 * counterparty is synced; this panel only assigns each one an account.
 *
 * Routing decides whether a counterparty maps to a single account (default) or
 * is handed to payroll period matching instead — see resolveExpenseMapping in
 * lib/finance/expenses.ts. A payroll-split counterparty has no single account
 * to pick, so the picker is replaced rather than disabled.
 */
import { useState } from "react";
import AccountSelect, { type CoARef } from "@/app/finance/AccountSelect";
import Badge from "@/app/components/ui/Badge";
import SaveHint from "@/app/components/ui/SaveHint";
import MappingFrame from "./MappingFrame";
import { useMappingData } from "./useMappingData";

const RULES_URL = "/api/finance/expense-counterparty-mappings";
const PAYROLL_DEPARTMENTS_HREF = "/settings/payroll/departments";

interface CoaJoin { account_name: string; account_number: string | null }

type CounterpartyRouting = "single_account" | "payroll_split";

interface RuleRow {
  id: string;
  counterparty_key: string;
  counterparty_label: string;
  chart_of_accounts_id: string | null;
  auto_matched: boolean;
  chart_of_accounts: CoaJoin | null;
  routing: CounterpartyRouting;
}

export default function CounterpartiesPanel() {
  const { accounts, rows, setRows, loading, error, setError } =
    useMappingData<RuleRow>(RULES_URL, "Failed to load counterparty accounts.");
  const [savingId, setSavingId] = useState<string | null>(null);

  async function patch(rule: RuleRow, body: Record<string, unknown>): Promise<boolean> {
    setSavingId(rule.id);
    const res = await fetch(RULES_URL, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rule.id, ...body }),
    });
    setSavingId(null);
    if (!res.ok) setError("Could not save that change.");
    return res.ok;
  }

  async function handleSetRule(rule: RuleRow, coaId: string | null) {
    if (!(await patch(rule, { chart_of_accounts_id: coaId }))) return;
    const coa = accounts.find((a) => a.id === coaId);
    const join: CoaJoin | null = coa
      ? { account_name: coa.account_name, account_number: coa.account_number }
      : null;
    setRows((rs) => rs.map((r) => (r.id === rule.id
      ? { ...r, chart_of_accounts_id: coaId, auto_matched: false, chart_of_accounts: join }
      : r)));
  }

  async function handleSetRouting(rule: RuleRow, routing: CounterpartyRouting) {
    if (!(await patch(rule, { routing }))) return;
    setRows((rs) => rs.map((r) => (r.id === rule.id ? { ...r, routing } : r)));
  }

  const mapped = rows.filter((r) => r.chart_of_accounts_id).length;

  return (
    <MappingFrame
      loading={loading}
      error={error}
      hasAccounts={accounts.length > 0}
      rowCount={rows.length}
      summary={rows.length > 0
        ? `${mapped} of ${rows.length} counterparties mapped to the chart of accounts`
        : "Counterparties appear here after syncing bank-account lines on the Transactions → Bank Ledger tab."}
      emptyRows={{
        title: "No counterparties yet.",
        hint: "Sync Ramp on the Transactions → Bank Ledger tab to import them.",
      }}
      headers={["Counterparty", "Routing", "Chart of Accounts"]}
      footer={
        <>
          Mapping a counterparty here codes every uncoded bank-line expense from it (e.g. Gusto
          payroll, Erie insurance). Rows are seeded automatically the first time that counterparty
          appears in a sync.
        </>
      }
    >
      {rows.map((rule) => (
        <tr key={rule.id} className="border-t border-line/40 hover:bg-surface-mid/20">
          <td className="px-4 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-body truncate">{rule.counterparty_label}</span>
              {rule.auto_matched && rule.chart_of_accounts_id && (
                <span className="text-2xs text-info shrink-0" title="Auto-matched from the counterparty name">
                  auto
                </span>
              )}
            </div>
          </td>
          <td className="px-4 py-2">
            <select
              className="inp-sm"
              value={rule.routing}
              onChange={(e) => handleSetRouting(rule, e.target.value as CounterpartyRouting)}
            >
              <option value="single_account">Single account</option>
              <option value="payroll_split">Payroll split</option>
            </select>
          </td>
          <td className="px-4 py-2">
            {rule.routing === "payroll_split" ? (
              <div className="flex items-center gap-2">
                <Badge tone="accent">Split by GL account — matched per pay period</Badge>
                <a href={PAYROLL_DEPARTMENTS_HREF} className="text-2xs text-accent hover:underline shrink-0">
                  Manage →
                </a>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <AccountSelect
                  value={rule.chart_of_accounts_id}
                  onChange={(id) => handleSetRule(rule, id)}
                  accounts={accounts as CoARef[]}
                  placeholder="— map this counterparty —"
                  shortLabel
                  className="w-full max-w-[360px]"
                />
                <SaveHint saving={savingId === rule.id} />
              </div>
            )}
          </td>
        </tr>
      ))}
    </MappingFrame>
  );
}
