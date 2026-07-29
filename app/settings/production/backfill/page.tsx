"use client";

// Deposit-invoice breakdown backfill (POST /api/production/deposit-invoices/backfill).
//
// Note the flag is INVERTED relative to the other backfills: this route takes
// `{ apply: true }` to write and treats a missing/false flag as a dry run,
// where the finance and payroll routes take `{ dryRun: false }` to write. The
// shell's preview/apply contract is normalized here rather than in the route,
// so an existing caller's payload keeps working.

import BackfillShell from "../../BackfillShell";
import Badge from "@/app/components/ui/Badge";
import { LedgerTable, Th } from "@/app/finance/transactions/components/LedgerTable";
import { formatCurrencyCents } from "@/lib/format";

interface DepositBackfillRow {
  invoice_id: string;
  status: string;
  lines: number;
  sum_cents: number;
  total_cents: number;
}

interface DepositBackfillResult {
  mode: "apply" | "dry-run";
  summary: { total: number; written: number; skipped: number; errored: number };
  results: DepositBackfillRow[];
}

async function post(apply: boolean): Promise<DepositBackfillResult> {
  const res = await fetch("/api/production/deposit-invoices/backfill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apply }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as DepositBackfillResult;
}

function blockers(r: DepositBackfillResult): string[] {
  const out: string[] = [];
  if (r.summary.errored > 0) {
    const detail = r.results
      .filter((x) => x.status.startsWith("error:"))
      .slice(0, 5)
      .map((x) => `${x.invoice_id.slice(0, 8)}: ${x.status}`);
    out.push(`${r.summary.errored} invoice(s) errored — ${detail.join("; ")}`);
  }
  return out;
}

export default function ProductionBackfillPage() {
  return (
    <BackfillShell<DepositBackfillResult>
      title="Deposit invoice breakdown backfill"
      what={
        <>
          Reconstructs each contract-brewing deposit invoice&rsquo;s ingredient breakdown as it stood
          on the invoice date, replaying the recipe and ingredient audit history, then freezes that
          breakdown onto the invoice.
        </>
      }
      impacts={
        <>
          Writes frozen breakdown lines for every existing <code>allocation_deposit</code> invoice.
          Does not change any invoice total — only the stored per-ingredient split beneath it.
        </>
      }
      preview={() => post(false)}
      apply={() => post(true)}
      blockers={blockers}
    >
      {(r, mode) => (
        <>
          <p className="text-xs text-secondary mb-2">
            {r.summary.total} deposit invoice(s) scanned ·{" "}
            {mode === "applied" ? `${r.summary.written} written` : "dry run, nothing written"} ·{" "}
            {r.summary.skipped} skipped · {r.summary.errored} errored
          </p>
          <LedgerTable
            head={
              <>
                <Th label="Invoice" />
                <Th label="Lines" align="right" />
                <Th label="Breakdown sum" align="right" />
                <Th label="Invoice total" align="right" />
                <Th label="Status" />
              </>
            }
          >
            {r.results.map((row) => (
              <tr key={row.invoice_id} className="border-b border-line-subtle last:border-0">
                <td className="px-4 py-2 text-body font-mono text-2xs">{row.invoice_id.slice(0, 8)}</td>
                <td className="px-4 py-2 text-right text-secondary tabular-nums">{row.lines}</td>
                <td className="px-4 py-2 text-right text-body tabular-nums">
                  {formatCurrencyCents(row.sum_cents)}
                </td>
                <td className="px-4 py-2 text-right text-secondary tabular-nums">
                  {formatCurrencyCents(row.total_cents)}
                </td>
                <td className="px-4 py-2">
                  {row.status.startsWith("error:") ? (
                    <Badge tone="danger">{row.status}</Badge>
                  ) : row.status.startsWith("skipped:") ? (
                    <Badge tone="neutral">{row.status}</Badge>
                  ) : (
                    <Badge tone="success">{row.status}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </LedgerTable>
          <p className="text-xs text-muted mt-2">
            Skipped rows are invoices with no linked recipe, no total, or no resolvable date — they
            carry no breakdown and are left alone. Errored rows are worth investigating before
            writing.
          </p>
        </>
      )}
    </BackfillShell>
  );
}
