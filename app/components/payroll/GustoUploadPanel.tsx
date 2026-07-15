"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import { fmtCents } from "@/lib/utils/formatting";
import type { CoARef } from "@/app/finance/AccountSelect";
import type { PayrollGlReport, PayrollGlReportTotal, PayrollGlReportEmployee } from "@/lib/payroll/types";

interface MatchedExpense {
  expenseId: string;
  amountCents: number;
  merchantName: string | null;
  accountingDate: string | null;
}

interface GustoReportState {
  report: PayrollGlReport | null;
  totals: PayrollGlReportTotal[];
  unmappedDepartments: string[];
  employees: PayrollGlReportEmployee[];
  matchedExpenses: MatchedExpense[];
}

// $1.00 -- variance beyond this between matched-expense totals and the
// uploaded report's own GL totals is flagged for review (reconciliation).
const VARIANCE_FLAG_CENTS = 100;

function accountLabel(accounts: CoARef[], id: string) {
  const a = accounts.find((acc) => acc.id === id);
  if (!a) return id.slice(0, 8) + "…";
  return a.account_number ? `${a.account_number} · ${a.account_name}` : a.account_name;
}

interface Props {
  periodId: string;
}

// Upload/parse a Gusto payroll journal CSV for this pay period, and show the
// audit trail (parsed employees, GL totals, unmapped-department warnings,
// and reconciliation against expenses already matched to this period).
export function GustoUploadPanel({ periodId }: Props) {
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [state, setState] = useState<GustoReportState | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadAll = useCallback(async () => {
    try {
      const [coaRes, reportRes] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch(`/api/payroll/periods/${periodId}/gusto-report`),
      ]);
      const coa = await coaRes.json();
      const report = await reportRes.json();
      if (!reportRes.ok) throw new Error(report?.error ?? "Failed to load Gusto report.");
      setAccounts(Array.isArray(coa) ? coa : []);
      setState(report as GustoReportState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Gusto report.");
    } finally {
      setLoading(false);
    }
  }, [periodId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAll(); }, [loadAll]);

  async function handleUpload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/payroll/periods/${periodId}/gusto-report`, { method: "POST", body: formData });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Upload failed.");

      // A re-upload changes the period's GL totals -- recompute every
      // already-matched expense's splits before refreshing the view (this is
      // the gap a Gusto upload alone doesn't close, see gustoUpload.ts's doc
      // comment).
      const recomputeRes = await fetch(`/api/finance/payroll-periods/${periodId}/recompute-splits`, { method: "POST" });
      if (!recomputeRes.ok) {
        const recomputeBody = await recomputeRes.json().catch(() => ({}));
        throw new Error(recomputeBody?.error ?? "Uploaded, but recomputing matched expenses' splits failed.");
      }

      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  if (loading) return <p className="text-muted text-sm p-6">Loading…</p>;
  if (!state) return null;

  const { report, totals, unmappedDepartments, employees, matchedExpenses } = state;
  const totalGlCents = totals.reduce((s, t) => s + t.amount_cents, 0);
  const totalMatchedCents = matchedExpenses.reduce((s, e) => s + e.amountCents, 0);
  const varianceCents = totalMatchedCents - totalGlCents;
  const hasReconciliation = report != null && matchedExpenses.length > 0;
  const varianceFlagged = hasReconciliation && Math.abs(varianceCents) > VARIANCE_FLAG_CENTS;
  const awaitingUploadCount = report == null ? matchedExpenses.length : 0;

  return (
    <div className="space-y-4">
      {error && <Banner>{error}</Banner>}

      {awaitingUploadCount > 0 && (
        <Banner tone="info">
          {awaitingUploadCount} transaction{awaitingUploadCount === 1 ? "" : "s"} waiting on a Gusto upload for this period.
        </Banner>
      )}

      {unmappedDepartments.length > 0 && (
        <Banner>
          {unmappedDepartments.length} department{unmappedDepartments.length === 1 ? "" : "s"} not mapped to a GL account
          (excluded from the totals below): <span className="text-body">{unmappedDepartments.join(", ")}</span>.{" "}
          <a href="/finance/settings/payroll-department-mappings" className="text-accent hover:underline">
            Map them →
          </a>
        </Banner>
      )}

      <div className="flex items-center gap-2">
        <input ref={fileInputRef} type="file" accept=".csv" className="inp-sm" disabled={uploading}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
        {uploading && <span className="text-xs text-muted">Uploading…</span>}
        {report && (
          <span className="text-xs text-faint">
            Current: {report.original_filename} (uploaded {new Date(report.uploaded_at).toLocaleString()})
          </span>
        )}
      </div>

      {!report && (
        <p className="text-xs text-faint">No Gusto payroll journal uploaded for this period yet.</p>
      )}

      {report && (
        <>
          <div>
            <h3 className="text-sm font-semibold text-strong mb-2">GL totals</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-strong">
                  <th className="text-left py-2 px-3 text-muted font-medium">Account</th>
                  <th className="text-right py-2 px-3 text-muted font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {totals.map((t) => (
                  <tr key={t.id} className="border-b border-line">
                    <td className="py-2 px-3 text-body">{accountLabel(accounts, t.chart_of_accounts_id)}</td>
                    <td className="py-2 px-3 text-right font-mono text-body">{fmtCents(t.amount_cents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line-strong">
                  <td className="py-2 px-3 text-muted text-xs font-medium">Total</td>
                  <td className="py-2 px-3 text-right font-mono font-semibold text-strong">{fmtCents(totalGlCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-strong mb-2">Parsed employees</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-strong">
                  <th className="text-left py-2 px-3 text-muted font-medium">Employee</th>
                  <th className="text-left py-2 px-3 text-muted font-medium">Department</th>
                  <th className="text-right py-2 px-3 text-muted font-medium">Gross</th>
                  <th className="text-right py-2 px-3 text-muted font-medium">Employer tax</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => (
                  <tr key={e.id} className="border-b border-line">
                    <td className="py-2 px-3 text-body">{e.first_name} {e.last_name}</td>
                    <td className="py-2 px-3 text-secondary">{e.department}</td>
                    <td className="py-2 px-3 text-right font-mono text-body">{fmtCents(e.gross_amount_cents)}</td>
                    <td className="py-2 px-3 text-right font-mono text-body">{fmtCents(e.employer_tax_cents)}</td>
                  </tr>
                ))}
                {employees.length === 0 && (
                  <tr><td colSpan={4} className="py-4 text-center text-faint text-xs">No employees parsed.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div>
        <h3 className="text-sm font-semibold text-strong mb-2">Matched transactions</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line-strong">
              <th className="text-left py-2 px-3 text-muted font-medium">Date</th>
              <th className="text-left py-2 px-3 text-muted font-medium">Merchant</th>
              <th className="text-right py-2 px-3 text-muted font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {matchedExpenses.map((e) => (
              <tr key={e.expenseId} className="border-b border-line">
                <td className="py-2 px-3 text-secondary">{e.accountingDate ?? "—"}</td>
                <td className="py-2 px-3 text-body">{e.merchantName ?? "—"}</td>
                <td className="py-2 px-3 text-right font-mono text-body">{fmtCents(e.amountCents)}</td>
              </tr>
            ))}
            {matchedExpenses.length === 0 && (
              <tr><td colSpan={3} className="py-4 text-center text-faint text-xs">No transactions matched to this period yet.</td></tr>
            )}
          </tbody>
        </table>

        {hasReconciliation && (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-muted">Matched total {fmtCents(totalMatchedCents)} vs. report total {fmtCents(totalGlCents)}</span>
            <Badge tone={varianceFlagged ? "danger" : "success"}>
              {varianceFlagged ? `Variance ${fmtCents(varianceCents)}` : "Reconciled"}
            </Badge>
          </div>
        )}
      </div>
    </div>
  );
}
