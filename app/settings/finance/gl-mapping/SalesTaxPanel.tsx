"use client";
/**
 * Square taxes → the balance-sheet liability account their collections are
 * credited to. Rows seed themselves the first time a tax is seen in a synced
 * order.
 *
 * Sales tax is money held for NC DOR / Wake County, not revenue. Only the two
 * liability account types are selectable, so a tax can never be mapped back
 * into an income account and posted as revenue — the exact bug this screen
 * exists to prevent.
 */
import { useState } from "react";
import AccountSelect, { type CoARef } from "@/app/finance/AccountSelect";
import SaveHint from "@/app/components/ui/SaveHint";
import MappingFrame from "./MappingFrame";
import { useMappingData } from "./useMappingData";

const TAXES_URL = "/api/finance/settings/sales-tax-accounts";

const LIABILITY_ACCOUNT_TYPES = new Set(["Other Current Liabilities", "Long Term Liabilities"]);

interface CoaJoin { account_name: string; account_number: string | null }

interface TaxRow {
  square_tax_id: string;
  tax_name: string | null;
  tax_pct: number | null;
  chart_of_accounts_id: string | null;
  chart_of_accounts: CoaJoin | null;
}

export default function SalesTaxPanel() {
  const { accounts, rows, setRows, loading, error, setError } =
    useMappingData<TaxRow>(TAXES_URL, "Failed to load sales tax accounts.");
  const [savingId, setSavingId] = useState<string | null>(null);

  async function handleSet(row: TaxRow, coaId: string | null) {
    setSavingId(row.square_tax_id);
    const res = await fetch(TAXES_URL, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ square_tax_id: row.square_tax_id, chart_of_accounts_id: coaId }),
    });
    setSavingId(null);
    if (!res.ok) { setError("Could not save that mapping."); return; }
    const coa = accounts.find((a) => a.id === coaId);
    const join: CoaJoin | null = coa
      ? { account_name: coa.account_name, account_number: coa.account_number }
      : null;
    setRows((ts) => ts.map((t) => (t.square_tax_id === row.square_tax_id
      ? { ...t, chart_of_accounts_id: coaId, chart_of_accounts: join }
      : t)));
  }

  const mapped = rows.filter((t) => t.chart_of_accounts_id).length;
  const liabilityAccounts = accounts.filter((a) => LIABILITY_ACCOUNT_TYPES.has(a.account_type));

  return (
    <MappingFrame
      loading={loading}
      error={error}
      hasAccounts={accounts.length > 0}
      rowCount={rows.length}
      summary={rows.length > 0
        ? `${mapped} of ${rows.length} Square taxes mapped to a liability account`
        : "Taxes appear here after syncing orders that collected sales tax."}
      emptyRows={{
        title: "No Square taxes yet.",
        hint: "Sync orders on the Transactions → Orders tab to import them.",
      }}
      headers={["Tax", "Rate", "Liability Account"]}
      footer={
        <>
          Collected sales tax is credited to the account mapped here instead of being recognized as
          revenue. An unmapped tax contributes nothing to the balance sheet — its collections are
          simply omitted. Only balance-sheet liability accounts are selectable, so a tax can never be
          mapped back into revenue.
        </>
      }
    >
      {rows.map((row) => (
        <tr key={row.square_tax_id} className="border-t border-line/40 hover:bg-surface-mid/20">
          <td className="px-4 py-2">
            <span className="text-body truncate">{row.tax_name ?? row.square_tax_id}</span>
          </td>
          <td className="px-4 py-2 text-secondary">
            {row.tax_pct != null ? `${row.tax_pct}%` : "—"}
          </td>
          <td className="px-4 py-2">
            <div className="flex items-center gap-2">
              <AccountSelect
                value={row.chart_of_accounts_id}
                onChange={(id) => handleSet(row, id)}
                accounts={liabilityAccounts as CoARef[]}
                placeholder="— map this tax —"
                shortLabel
                className="w-full max-w-[360px]"
              />
              <SaveHint saving={savingId === row.square_tax_id} />
            </div>
          </td>
        </tr>
      ))}
    </MappingFrame>
  );
}
