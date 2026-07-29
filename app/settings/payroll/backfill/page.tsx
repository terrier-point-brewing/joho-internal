"use client";

// Tips GL backfill (POST /api/payroll/gl-reports/backfill).
//
// Ported from app/finance/payroll/GlBackfillPanel.tsx, which sat collapsed at the
// bottom of the pay-periods page where nothing in the nav pointed at it. The
// preview -> review -> run gate and the bucket-total invariant below are that
// component's, unchanged: the backfill RECLASSIFIES dollars between
// wages/employer_tax/tips and must never create or destroy any, so a period
// whose total moved is a defect, not a rounding artefact.

import { useState } from "react";
import BackfillShell from "../../BackfillShell";
import Badge from "@/app/components/ui/Badge";
import { LedgerTable, Th } from "@/app/finance/transactions/components/LedgerTable";
import { formatCurrencyCents } from "@/lib/format";
import { fmtDate } from "@/lib/utils/formatting";
import type { BackfillBucketSummary, BackfillPeriodResult } from "@/lib/payroll/glBackfill";
import type { PayPeriodSummary } from "@/lib/payroll/types";

function total(s: BackfillBucketSummary): number {
  return s.wagesCents + s.employerTaxCents + s.tipsCents;
}

async function post(dryRun: boolean): Promise<BackfillPeriodResult[]> {
  const res = await fetch("/api/payroll/gl-reports/backfill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return (body.results ?? []) as BackfillPeriodResult[];
}

function blockers(rows: BackfillPeriodResult[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.error) out.push(`Period ${r.payPeriodId.slice(0, 8)}: ${r.error}`);
    else if (total(r.before) !== total(r.after)) {
      out.push(
        `Period ${r.payPeriodId.slice(0, 8)}: bucket total changed (${formatCurrencyCents(total(r.before))} → ${formatCurrencyCents(total(r.after))}). The backfill must only reclassify dollars.`,
      );
    }
  }
  return out;
}

export default function PayrollBackfillPage() {
  const [periods, setPeriods] = useState<PayPeriodSummary[] | null>(null);

  // Loaded lazily on first result so rows read as date ranges rather than raw ids.
  async function ensurePeriods() {
    if (periods) return;
    try {
      const res = await fetch("/api/payroll/periods");
      if (res.ok) setPeriods(await res.json());
    } catch {
      // Labels degrade to a truncated id — not worth failing the screen over.
    }
  }

  const label = (id: string): string => {
    const p = periods?.find((x) => x.id === id);
    return p ? `${fmtDate(p.start_date)} – ${fmtDate(p.end_date)}` : id.slice(0, 8);
  };

  return (
    <BackfillShell<BackfillPeriodResult[]>
      title="Tips GL backfill"
      what={
        <>
          Re-parses each pay period&rsquo;s stored Gusto CSV so paycheck tips move out of the wage
          accounts and onto the tips liability, then recomputes that period&rsquo;s expense splits.
        </>
      }
      impacts={
        <>
          <code>payroll_gl_report_totals</code> and <code>expense_gl_splits</code>. Roughly
          $900–$1,050 per period leaves Direct Production Labor and Taproom Staff Wages, so COGS
          falls and gross margin improves. Manual split overrides are left untouched.
        </>
      }
      preview={async () => {
        const r = await post(true);
        await ensurePeriods();
        return r;
      }}
      apply={() => post(false)}
      blockers={blockers}
    >
      {(rows, mode) =>
        rows.length === 0 ? (
          <p className="text-sm text-secondary">No active Gusto reports found — nothing to backfill.</p>
        ) : (
          <>
            <LedgerTable
              head={
                <>
                  <Th label="Pay period" />
                  <Th label="Total before" align="right" />
                  <Th label="Total after" align="right" />
                  <Th label="Wages" align="right" />
                  <Th label="Employer tax" align="right" />
                  <Th label="Tips" align="right" />
                  <Th label="" />
                </>
              }
            >
              {rows.map((r) => (
                <tr key={r.reportId} className="border-b border-line-subtle last:border-0">
                  <td className="px-4 py-2 text-body">{label(r.payPeriodId)}</td>
                  <td className="px-4 py-2 text-right text-body tabular-nums">
                    {formatCurrencyCents(total(r.before))}
                  </td>
                  <td className="px-4 py-2 text-right text-body tabular-nums">
                    {formatCurrencyCents(total(r.after))}
                  </td>
                  <td className="px-4 py-2 text-right text-secondary tabular-nums">
                    {formatCurrencyCents(r.after.wagesCents)}
                  </td>
                  <td className="px-4 py-2 text-right text-secondary tabular-nums">
                    {formatCurrencyCents(r.after.employerTaxCents)}
                  </td>
                  <td className="px-4 py-2 text-right text-body tabular-nums">
                    {formatCurrencyCents(r.after.tipsCents)}
                  </td>
                  <td className="px-4 py-2">
                    {r.error ? (
                      <Badge tone="danger">{r.error}</Badge>
                    ) : total(r.before) !== total(r.after) ? (
                      <Badge tone="danger">Total changed</Badge>
                    ) : mode === "applied" ? (
                      <Badge tone="success">Written</Badge>
                    ) : (
                      <Badge tone="success">OK</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </LedgerTable>
            <p className="text-xs text-muted mt-2">
              &ldquo;Total before&rdquo; and &ldquo;Total after&rdquo; must match on every row. The
              wage figure drops by more than the tips amount because pre-backfill rows lumped
              employer tax in with wages; that part is reclassification, not movement.
            </p>
          </>
        )
      }
    </BackfillShell>
  );
}
