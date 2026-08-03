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
 *
 * The Filings column is the bridge to Settings → Tax → Tax Filing, which picks
 * these same Square taxes from the other direction (which tax PLAYS a role in a
 * return). Without it the two screens are blind to each other, and a tax can be
 * excluded here while a live return still computes tax owed from it — the
 * filing says money is due, the balance sheet says it was never collected.
 */
import { useState, type ReactNode } from "react";
import AccountSelect, { type CoARef } from "@/app/finance/AccountSelect";
import SaveHint from "@/app/components/ui/SaveHint";
import ToggleChip from "@/app/components/ui/ToggleChip";
import type { Tone } from "@/app/components/ui/tone";
import type { SquareTaxReference } from "@/lib/tax/squareTaxUsage";
import MappingFrame from "./MappingFrame";
import { isOrphanedFiling } from "./salesTaxFilings";
import { useMappingData } from "./useMappingData";

const TAXES_URL = "/api/finance/settings/sales-tax-accounts";
const TAX_FILING_HREF = "/settings/tax/filing";

const LIABILITY_ACCOUNT_TYPES = new Set(["Other Current Liabilities", "Long Term Liabilities"]);

interface CoaJoin { account_name: string; account_number: string | null }

interface TaxRow {
  square_tax_id: string;
  tax_name: string | null;
  tax_pct: number | null;
  chart_of_accounts_id: string | null;
  excluded: boolean;
  chart_of_accounts: CoaJoin | null;
  filing_refs: SquareTaxReference[];
}

/**
 * The count of active filings depending on this tax, listing them on hover.
 * Turns danger when the dependency is already broken — an excluded or unmapped
 * tax whose collections a live return still expects to see on the books.
 */
function FilingsCell({ row }: { row: TaxRow }) {
  const count = row.filing_refs.length;
  if (count === 0) {
    return <span className="text-faint" title="No active tax filing references this tax">—</span>;
  }
  const detail = row.filing_refs.map((r) => `${r.party_label} — ${r.field_label}`).join("\n");
  const broken = isOrphanedFiling(row);
  return (
    <span
      className={broken ? "text-danger font-medium" : "text-body"}
      title={broken
        ? `${detail}\n\nThis tax is excluded or unmapped, so its collections never reach the balance sheet — but the filings above still compute tax owed from it.`
        : detail}
    >
      {broken && "⚠ "}
      {count}
    </span>
  );
}

export default function SalesTaxPanel({ selector }: { selector?: ReactNode }) {
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

  async function handleSetExcluded(row: TaxRow, excluded: boolean) {
    setSavingId(row.square_tax_id);
    const res = await fetch(TAXES_URL, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ square_tax_id: row.square_tax_id, excluded }),
    });
    setSavingId(null);
    if (!res.ok) { setError("Could not save that change."); return; }
    setRows((ts) => ts.map((t) => (t.square_tax_id === row.square_tax_id ? { ...t, excluded } : t)));
  }

  // Excluded rows will never get a liability account — a person already
  // decided that — so they drop out of the denominator instead of reading as
  // a permanently unmapped tax.
  const excludedCount = rows.filter((t) => t.excluded).length;
  const needsMapping = rows.length - excludedCount;
  const mapped = rows.filter((t) => t.chart_of_accounts_id && !t.excluded).length;
  const liabilityAccounts = accounts.filter((a) => LIABILITY_ACCOUNT_TYPES.has(a.account_type));
  // A tax an active return files on, that the balance sheet will never carry.
  // This outranks the mapped/unmapped count: "all excluded" would otherwise read
  // as neutral while a live filing quietly depends on one of those exclusions.
  const orphaned = rows.filter(isOrphanedFiling);
  // Danger draws the eye when something still needs a decision; success confirms
  // there's nothing left to do; neutral covers "no data yet" / "all excluded".
  const summaryTone: Tone = orphaned.length > 0
    ? "danger"
    : rows.length === 0 || needsMapping === 0
    ? "neutral"
    : mapped === needsMapping ? "success" : "danger";

  return (
    <MappingFrame
      selector={selector}
      loading={loading}
      error={error}
      hasAccounts={accounts.length > 0}
      rowCount={rows.length}
      summary={rows.length === 0
        ? "Taxes appear here after syncing orders that collected sales tax."
        : orphaned.length > 0
        ? `${orphaned.length} tax${orphaned.length === 1 ? "" : "es"} an active filing depends on `
          + `${orphaned.length === 1 ? "is" : "are"} excluded or unmapped — `
          + `${orphaned.length === 1 ? "that return" : "those returns"} will report tax owed that the balance sheet never carries.`
        : needsMapping === 0
        ? `All ${rows.length} Square taxes excluded from mapping`
        : `${mapped} of ${needsMapping} Square taxes mapped to a liability account`
          + (excludedCount > 0 ? ` (${excludedCount} excluded)` : "")}
      summaryTone={summaryTone}
      emptyRows={{
        title: "No Square taxes yet.",
        hint: "Sync orders on the Transactions → Orders tab to import them.",
      }}
      headers={["Tax", "Rate", "Filings", "Excluded", "Liability Account"]}
      footer={
        <>
          Collected sales tax is credited to the account mapped here instead of being recognized as
          revenue. An unmapped tax contributes nothing to the balance sheet — its collections are
          simply omitted. Only balance-sheet liability accounts are selectable, so a tax can never be
          mapped back into revenue. Mark a tax excluded when it should never get a liability
          account (e.g. a $0 test tax) — excluded taxes stop counting toward the summary above.
          {" "}Filings counts the active tax filings in{" "}
          <a href={TAX_FILING_HREF} className="text-accent hover:underline">Settings → Tax → Tax Filing</a>{" "}
          that compute a return from each tax; hover the count to see which. Excluding or unmapping a
          tax with a filing against it breaks that return&apos;s books, so those rows are flagged.
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
            <FilingsCell row={row} />
          </td>
          <td className="px-4 py-2">
            <ToggleChip active={row.excluded} onClick={() => handleSetExcluded(row, !row.excluded)}>
              {row.excluded ? "Yes" : "No"}
            </ToggleChip>
          </td>
          <td className="px-4 py-2">
            {row.excluded ? (
              <span
                className={row.filing_refs.length > 0 ? "text-2xs text-danger" : "text-2xs text-faint"}
                title={row.filing_refs.length > 0
                  ? "Excluded, but an active filing still computes a return from this tax"
                  : "This tax was marked excluded from mapping"}
              >
                excluded
              </span>
            ) : (
              <div className="flex items-center gap-2">
                <AccountSelect
                  value={row.chart_of_accounts_id}
                  onChange={(id) => handleSet(row, id)}
                  accounts={liabilityAccounts as CoARef[]}
                  placeholder="— map this tax —"
                  shortLabel
                  className="w-full max-w-[360px]"
                />
              </div>
            )}
            <SaveHint saving={savingId === row.square_tax_id} />
          </td>
        </tr>
      ))}
    </MappingFrame>
  );
}
