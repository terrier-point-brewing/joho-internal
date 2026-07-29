"use client";

// Sales-tax backfill (POST /api/finance/backfill/sales-tax).
//
// Four steps, reported separately: strip tax out of pos_line_items.net_sales_cents,
// repair invoice_line_items.square_line_item_uid, rebuild invoice_line_item_taxes
// off the repaired key, and repair invoice_line_items.total_cents.
//
// The two skip counters are the reason this needs a UI rather than a curl: a
// non-zero skippedIdentityMismatch or a non-empty invoicesSkipped means rows
// the backfill REFUSED to guess at, and both are easy to scroll past in raw JSON.
// They block the run here.

import BackfillShell from "../../BackfillShell";
import Badge from "@/app/components/ui/Badge";
import { LedgerTable, Th } from "@/app/finance/transactions/components/LedgerTable";
import { formatCurrencyCents } from "@/lib/format";
import type { BackfillSalesTaxReport } from "@/lib/finance/backfillSalesTax";

async function post(dryRun: boolean): Promise<BackfillSalesTaxReport> {
  const res = await fetch("/api/finance/backfill/sales-tax", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as BackfillSalesTaxReport;
}

function blockers(r: BackfillSalesTaxReport): string[] {
  const out: string[] = [];
  if (r.posNetSales.skippedIdentityMismatch > 0) {
    out.push(
      `${r.posNetSales.skippedIdentityMismatch} POS line(s) do not satisfy net = gross − discount + tax, so the correction is not provably safe on them. Investigate before writing.`,
    );
  }
  if (r.invoiceUids.invoicesSkipped.length > 0) {
    out.push(
      `${r.invoiceUids.invoicesSkipped.length} invoice(s) could not be matched line-for-line against Square and were refused rather than half-repaired.`,
    );
  }
  if (r.invoiceTotals.skippedNullMoney > 0) {
    out.push(`${r.invoiceTotals.skippedNullMoney} invoice line(s) have null gross/discount and were skipped.`);
  }
  if (r.errors.length > 0) out.push(...r.errors);
  return out;
}

export default function FinanceBackfillPage() {
  return (
    <BackfillShell<BackfillSalesTaxReport>
      title="Sales tax backfill"
      what={
        <>
          Removes collected sales tax from recognized revenue and rebuilds the per-line tax rows the
          balance-sheet liability is derived from. Corrects history written before sales tax was
          treated as a liability.
        </>
      }
      impacts={
        <>
          <code>pos_line_items.net_sales_cents</code>, <code>invoice_line_items.total_cents</code>{" "}
          and <code>.square_line_item_uid</code>, and <code>invoice_line_item_taxes</code>. Taproom
          revenue drops on the P&amp;L for every affected month; the NC DOR and Wake County
          worksheets change with it.
        </>
      }
      preview={() => post(true)}
      apply={() => post(false)}
      blockers={blockers}
    >
      {(r, mode) => (
        <>
          <LedgerTable
            head={
              <>
                <Th label="Step" />
                <Th label="Scanned" align="right" />
                <Th label={mode === "applied" ? "Changed" : "Would change"} align="right" />
                <Th label="Skipped" align="right" />
                <Th label="" />
              </>
            }
          >
            <tr className="border-b border-line-subtle">
              <td className="px-4 py-2 text-body">POS net sales (tax removed)</td>
              <td className="px-4 py-2 text-right text-secondary tabular-nums">{r.posNetSales.scanned}</td>
              <td className="px-4 py-2 text-right text-body tabular-nums">{r.posNetSales.corrected}</td>
              <td className="px-4 py-2 text-right tabular-nums">
                {r.posNetSales.skippedIdentityMismatch > 0 ? (
                  <Badge tone="danger">{r.posNetSales.skippedIdentityMismatch}</Badge>
                ) : (
                  <span className="text-secondary">0</span>
                )}
              </td>
              <td className="px-4 py-2 text-right text-body tabular-nums">
                −{formatCurrencyCents(r.posNetSales.centsRemoved)}
              </td>
            </tr>
            <tr className="border-b border-line-subtle">
              <td className="px-4 py-2 text-body">Invoice line uid repair</td>
              <td className="px-4 py-2 text-right text-secondary tabular-nums">{r.invoiceUids.invoicesScanned}</td>
              <td className="px-4 py-2 text-right text-body tabular-nums">{r.invoiceUids.rowsRepaired}</td>
              <td className="px-4 py-2 text-right tabular-nums">
                {r.invoiceUids.invoicesSkipped.length > 0 ? (
                  <Badge tone="danger">{r.invoiceUids.invoicesSkipped.length}</Badge>
                ) : (
                  <span className="text-secondary">0</span>
                )}
              </td>
              <td />
            </tr>
            <tr className="border-b border-line-subtle">
              <td className="px-4 py-2 text-body">Invoice tax rows</td>
              <td className="px-4 py-2 text-right text-secondary tabular-nums">{r.invoiceTaxes.invoicesScanned}</td>
              <td className="px-4 py-2 text-right text-body tabular-nums">{r.invoiceTaxes.rowsWritten}</td>
              <td className="px-4 py-2 text-right text-secondary tabular-nums">0</td>
              <td className="px-4 py-2 text-right text-body tabular-nums">
                {formatCurrencyCents(r.invoiceTaxes.centsWritten)}
              </td>
            </tr>
            <tr className="last:border-0">
              <td className="px-4 py-2 text-body">Invoice totals</td>
              <td className="px-4 py-2 text-right text-secondary tabular-nums">{r.invoiceTotals.scanned}</td>
              <td className="px-4 py-2 text-right text-body tabular-nums">{r.invoiceTotals.corrected}</td>
              <td className="px-4 py-2 text-right tabular-nums">
                {r.invoiceTotals.skippedNullMoney > 0 ? (
                  <Badge tone="danger">{r.invoiceTotals.skippedNullMoney}</Badge>
                ) : (
                  <span className="text-secondary">0</span>
                )}
              </td>
              <td />
            </tr>
          </LedgerTable>

          <h3 className="text-xs font-medium text-strong mt-4 mb-1">Revenue reduction by month</h3>
          <LedgerTable
            head={
              <>
                <Th label="Month" />
                <Th label="Tax removed from revenue" align="right" />
              </>
            }
          >
            {Object.keys(r.posNetSales.byMonth)
              .sort()
              .map((m) => (
                <tr key={m} className="border-b border-line-subtle last:border-0">
                  <td className="px-4 py-2 text-body">{m}</td>
                  <td className="px-4 py-2 text-right text-body tabular-nums">
                    −{formatCurrencyCents(r.posNetSales.byMonth[m])}
                  </td>
                </tr>
              ))}
          </LedgerTable>

          {r.invoiceUids.invoicesSkipped.length > 0 && (
            <p className="text-xs text-muted mt-2">
              Skipped invoices: {r.invoiceUids.invoicesSkipped.join(", ")}
            </p>
          )}

          <p className="text-xs text-muted mt-2">
            Every skip count above should read 0. A skipped row is one the backfill refused to guess
            at — it is a signal to investigate, not noise to scroll past.
          </p>
        </>
      )}
    </BackfillShell>
  );
}
