"use client";

// Operator UI for the one-time tips GL backfill (POST /api/payroll/gl-reports/backfill).
// Preview -> review -> run, with the live run gated behind a clean preview so the
// irreversible write can't be reached without first seeing what it would do.
//
// The gate mirrors what a careful operator would check by hand: every period's
// bucket total must be unchanged (the backfill RECLASSIFIES dollars between
// wages/employer_tax/tips, it must never create or destroy any) and no period
// may report an error. Preview is cleared after a live run so a second run
// requires a fresh preview.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import { LedgerTable, Th } from "@/app/finance/transactions/components/LedgerTable";
import { formatCurrencyCents } from "@/lib/format";
import { fmtDate } from "@/lib/utils/formatting";
import { queryKeys } from "@/lib/query-keys";
import type { BackfillBucketSummary, BackfillPeriodResult } from "@/lib/payroll/glBackfill";
import type { PayPeriodSummary } from "@/lib/payroll/types";

function total(s: BackfillBucketSummary): number {
  return s.wagesCents + s.employerTaxCents + s.tipsCents;
}

/** A period is safe to write when its bucket total is unchanged and it reported no error. */
function isClean(r: BackfillPeriodResult): boolean {
  return !r.error && total(r.before) === total(r.after);
}

async function postBackfill(dryRun: boolean): Promise<BackfillPeriodResult[]> {
  const res = await fetch("/api/payroll/gl-reports/backfill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return (body.results ?? []) as BackfillPeriodResult[];
}

export default function GlBackfillPanel() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<BackfillPeriodResult[] | null>(null);
  const [applied, setApplied] = useState<BackfillPeriodResult[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<null | "preview" | "run">(null);
  const [error, setError] = useState<string | null>(null);

  // Reuse the page's cached periods so rows can be labelled by date range
  // rather than by a raw pay_period_id.
  const { data: periods } = useQuery<PayPeriodSummary[]>({
    queryKey: queryKeys.payroll.periods(),
    queryFn: () => fetch("/api/payroll/periods").then((r) => r.json()),
    enabled: open,
  });

  const periodLabel = (id: string): string => {
    const p = periods?.find((x) => x.id === id);
    return p ? `${fmtDate(p.start_date)} – ${fmtDate(p.end_date)}` : id.slice(0, 8);
  };

  const rows = applied ?? preview;
  const blockers = preview?.filter((r) => !isClean(r)) ?? [];
  const canRun = preview !== null && preview.length > 0 && blockers.length === 0;

  async function run(dryRun: boolean) {
    setBusy(dryRun ? "preview" : "run");
    setError(null);
    try {
      const results = await postBackfill(dryRun);
      if (dryRun) {
        setPreview(results);
        setApplied(null);
      } else {
        setApplied(results);
        setPreview(null); // force a fresh preview before any second run
      }
      setConfirming(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <div className="mt-6">
        <button onClick={() => setOpen(true)} className="btn-secondary btn-xxs">
          Tips GL backfill…
        </button>
      </div>
    );
  }

  return (
    <Card className="mt-6">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-strong">Tips GL backfill</h2>
          <p className="text-xs text-secondary mt-1 max-w-2xl">
            Re-parses each pay period&rsquo;s stored Gusto CSV so paycheck tips move out of the wage
            accounts and onto the tips liability. Preview writes nothing. Run this once, after a
            database backup.
          </p>
        </div>
        <button onClick={() => setOpen(false)} className="btn-secondary btn-xxs shrink-0">
          Close
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => run(true)} disabled={busy !== null} className="btn-secondary">
          {busy === "preview" ? "Previewing…" : "Preview changes"}
        </button>

        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            disabled={!canRun || busy !== null}
            className="btn-primary"
            title={canRun ? undefined : "Run a clean preview first"}
          >
            Run backfill
          </button>
        ) : (
          <>
            <button onClick={() => run(false)} disabled={busy !== null} className="btn-danger">
              {busy === "run" ? "Writing…" : "Confirm — write changes"}
            </button>
            <button onClick={() => setConfirming(false)} disabled={busy !== null} className="btn-secondary">
              Cancel
            </button>
          </>
        )}
      </div>

      {error && <Banner className="mt-3">{error}</Banner>}

      {applied && (
        <Banner tone="success" className="mt-3">
          Backfill applied to {applied.length} period{applied.length === 1 ? "" : "s"}.
          {applied.some((r) => r.error) && " Some periods reported errors — review the table below."}
        </Banner>
      )}

      {preview && blockers.length > 0 && (
        <Banner className="mt-3">
          {blockers.length} period{blockers.length === 1 ? "" : "s"} cannot be written safely — either
          the bucket total changed or the period reported an error. Resolve these before running.
        </Banner>
      )}

      {preview && preview.length === 0 && (
        <Banner tone="info" className="mt-3">
          No active Gusto reports found — there is nothing to backfill.
        </Banner>
      )}

      {rows && rows.length > 0 && (
        <div className="mt-3">
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
                <td className="px-4 py-2 text-body">{periodLabel(r.payPeriodId)}</td>
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
                  ) : applied ? (
                    <Badge tone="success">Written</Badge>
                  ) : (
                    <Badge tone="success">OK</Badge>
                  )}
                </td>
              </tr>
            ))}
          </LedgerTable>

          <p className="text-xs text-muted mt-2 max-w-2xl">
            &ldquo;Total before&rdquo; and &ldquo;Total after&rdquo; must match on every row — the backfill
            reclassifies dollars, it never creates or removes them. Expect roughly $900–$1,050 of tips
            per period. The wage figure drops by more than the tips amount because pre-backfill rows
            lumped employer tax in with wages; that part is reclassification, not movement.
          </p>
        </div>
      )}
    </Card>
  );
}
