"use client";
/**
 * Expense source accounts (Ramp GL accounts) → Chart of Accounts.
 *
 * Setting a rule here codes every expense on that account except manually
 * pinned rows, and Transactions › Expenses' "Auto-map all" re-applies these
 * rules on demand. Feeds the P&L expense side.
 */
import AccountSelect, { type CoARef } from "@/app/finance/AccountSelect";
import SaveHint from "@/app/components/ui/SaveHint";
import ToggleChip from "@/app/components/ui/ToggleChip";
import MappingFrame from "./MappingFrame";
import { useMappingData } from "./useMappingData";
import { useState } from "react";

const RULES_URL = "/api/finance/expense-mappings";

interface CoaJoin { account_name: string; account_number: string | null; account_type: string }

interface RuleRow {
  id: string;
  source: string;
  external_account_id: string;
  external_account_name: string;
  external_account_code: string | null;
  chart_of_accounts_id: string | null;
  auto_matched: boolean;
  excluded: boolean;
  chart_of_accounts: CoaJoin | null;
}

export default function ExpensesPanel() {
  const { accounts, rows, setRows, loading, error, setError } =
    useMappingData<RuleRow>(RULES_URL, "Failed to load expense accounts.");
  const [savingId, setSavingId] = useState<string | null>(null);

  async function handleSetRule(rule: RuleRow, coaId: string | null) {
    setSavingId(rule.id);
    const res = await fetch(RULES_URL, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: rule.source,
        external_account_id: rule.external_account_id,
        chart_of_accounts_id: coaId,
      }),
    });
    setSavingId(null);
    if (!res.ok) { setError("Could not save that mapping."); return; }
    const coa = accounts.find((a) => a.id === coaId);
    const join: CoaJoin | null = coa
      ? { account_name: coa.account_name, account_number: coa.account_number, account_type: coa.account_type }
      : null;
    setRows((rs) => rs.map((r) => (r.id === rule.id
      ? { ...r, chart_of_accounts_id: coaId, auto_matched: false, chart_of_accounts: join }
      : r)));
  }

  async function handleSetExcluded(rule: RuleRow, excluded: boolean) {
    setSavingId(rule.id);
    const res = await fetch(RULES_URL, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: rule.source, external_account_id: rule.external_account_id, excluded }),
    });
    setSavingId(null);
    if (!res.ok) { setError("Could not save that change."); return; }
    setRows((rs) => rs.map((r) => (r.id === rule.id ? { ...r, excluded } : r)));
  }

  // An excluded source account will never get a blanket rule — a person
  // already decided that — so it drops out of the denominator instead of
  // reading as a permanently unmapped account.
  const excludedCount = rows.filter((r) => r.excluded).length;
  const needsMapping = rows.length - excludedCount;
  const mapped = rows.filter((r) => r.chart_of_accounts_id && !r.excluded).length;

  return (
    <MappingFrame
      loading={loading}
      error={error}
      hasAccounts={accounts.length > 0}
      rowCount={rows.length}
      summary={rows.length === 0
        ? "Source accounts appear here after importing expenses on the Transactions → Expenses tab."
        : needsMapping === 0
        ? `All ${rows.length} source accounts excluded from mapping`
        : `${mapped} of ${needsMapping} source accounts mapped to the chart of accounts`
          + (excludedCount > 0 ? ` (${excludedCount} excluded)` : "")}
      emptyRows={{
        title: "No expense source accounts yet.",
        hint: "Sync Ramp on the Transactions → Expenses tab to import them.",
      }}
      headers={["Source account", "Excluded", "Chart of Accounts"]}
      footer={
        <>
          Mapping a source account here codes every expense on it (except manually-pinned rows).
          Use <span className="text-body">Auto-map all</span> on the Expenses tab to re-apply these
          rules to unmapped expenses. Mark a source account excluded when it should never get a
          blanket rule (e.g. a catch-all account coded line by line) — excluded accounts stop
          counting toward the summary above.
        </>
      }
    >
      {rows.map((rule) => (
        <tr key={rule.id} className="border-t border-line/40 hover:bg-surface-mid/20">
          <td className="px-4 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-body truncate">{rule.external_account_name}</span>
              {rule.external_account_code && (
                <span className="text-2xs text-faint font-mono shrink-0">{rule.external_account_code}</span>
              )}
              {rule.auto_matched && rule.chart_of_accounts_id && (
                <span className="text-2xs text-info shrink-0" title="Auto-matched from the source account name">
                  auto
                </span>
              )}
            </div>
          </td>
          <td className="px-4 py-2">
            <ToggleChip active={rule.excluded} onClick={() => handleSetExcluded(rule, !rule.excluded)}>
              {rule.excluded ? "Yes" : "No"}
            </ToggleChip>
          </td>
          <td className="px-4 py-2">
            <div className="flex items-center gap-2">
              {rule.excluded ? (
                <span className="text-2xs text-faint" title="This source account was marked excluded from mapping">
                  excluded
                </span>
              ) : (
                <AccountSelect
                  value={rule.chart_of_accounts_id}
                  onChange={(id) => handleSetRule(rule, id)}
                  accounts={accounts as CoARef[]}
                  placeholder="— map this account —"
                  shortLabel
                  className="w-full max-w-[360px]"
                />
              )}
              <SaveHint saving={savingId === rule.id} />
            </div>
          </td>
        </tr>
      ))}
    </MappingFrame>
  );
}
