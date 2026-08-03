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
import Banner from "@/app/components/ui/Banner";
import { LedgerTable, Th } from "@/app/finance/transactions/components/LedgerTable";
import { formatCurrencyCents } from "@/lib/format";
import { fmtDate } from "@/lib/utils/formatting";
import type { BackfillBucketSummary, BackfillPeriodResult } from "@/lib/payroll/glBackfill";
import type { PayPeriodSummary } from "@/lib/payroll/types";

/**
 * The bucket total EXCLUDING tips — the figure that must not move.
 *
 * The obvious invariant ("total before === total after") is wrong here, and
 * blocked every period. `before` reads the stored payroll_gl_report_totals,
 * where every pre-backfill row carries bucket_kind 'wages' — the column default
 * from migration 20260824, which backfilled nothing — and gustoParser has
 * always excluded paycheck tips from the GL totals entirely ("Never folded into
 * grossAmountCents"). So tips were never in these totals to be reclassified out
 * of: the backfill ADDS a tips bucket, and the grand total is SUPPOSED to grow
 * by exactly the tip amount.
 *
 * What must hold instead is that the non-tip payroll is untouched — the
 * backfill may split a lump 'wages' row into wages + employer_tax, but it must
 * not change what those two sum to. Comparing this way also stays correct on a
 * re-run, where `before` already carries a tips bucket.
 */
function nonTips(s: BackfillBucketSummary): number {
  return s.wagesCents + s.employerTaxCents;
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

/** Cents of the delta attributable to wage accounts the original upload dropped. */
function recoveredCents(r: BackfillPeriodResult): number {
  return (r.recoveredAccounts ?? []).reduce((s, a) => s + a.amountCents, 0);
}

/**
 * Sub-row pay types the stored totals cannot contain, because the parser that
 * wrote them folded only "Bonus" sub-rows into gross and dropped these two
 * entirely — neither adding them to gross nor tracking them anywhere. That was
 * a real understatement of payroll expense ($257.21 across three 2026 periods,
 * all of it in Taproom Staff Wages), fixed in gustoParser on 2026-08-03.
 *
 * Listed here rather than in the parser so the parser stays free of its own
 * history: this is the write gate's knowledge of what the PREVIOUS parser could
 * and could not have recorded. Once every active report has been re-parsed,
 * these amounts are inside the stored totals, the deltas go to zero, and this
 * set stops mattering — it is not a permanent exemption.
 */
const LABELS_THE_OLD_PARSER_DROPPED = new Set(["Commission", "Additional Earnings"]);

/** Cents of the delta attributable to pay types the parser used to drop. */
function newlyRecognisedCents(r: BackfillPeriodResult): number {
  return (r.wageSubRowTotals ?? [])
    .filter((t) => LABELS_THE_OLD_PARSER_DROPPED.has(t.label))
    .reduce((s, t) => s + t.amountCents, 0);
}

/** Every cause that can legitimately raise non-tip payroll on a re-parse. */
function explainedCents(r: BackfillPeriodResult): number {
  return recoveredCents(r) + newlyRecognisedCents(r);
}

/**
 * A non-tip delta is ACCOUNTED FOR when it equals, to the cent, the sum of the
 * causes this screen can itemise:
 *
 *  - wages recovered from accounts the stored totals never had — the signature
 *    of a report uploaded before its department was mapped, whose gross
 *    `computeGlBucketTotals` then silently skipped; and
 *  - wages from pay types the parser that wrote those totals did not recognise.
 *
 * Both are the backfill correcting a real understatement, so they warn rather
 * than block. Any other movement still blocks, including a delta that merely
 * falls short of or overshoots the itemised total: an unexplained change means
 * the re-parse and the stored totals disagree for a reason nobody has
 * established, and no partial match is evidence that they don't.
 */
function isExplained(r: BackfillPeriodResult): boolean {
  return nonTips(r.after) - nonTips(r.before) === explainedCents(r) && explainedCents(r) > 0;
}

function blockers(rows: BackfillPeriodResult[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.error) out.push(`Period ${r.payPeriodId.slice(0, 8)}: ${r.error}`);
    else if (nonTips(r.before) !== nonTips(r.after) && !isExplained(r)) {
      const delta = nonTips(r.after) - nonTips(r.before);
      out.push(
        `Period ${r.payPeriodId.slice(0, 8)}: non-tip payroll changed by ${delta > 0 ? "+" : ""}${formatCurrencyCents(delta)} (${formatCurrencyCents(nonTips(r.before))} → ${formatCurrencyCents(nonTips(r.after))}) with no accounting for it. Re-parsing the stored CSV should reproduce the recorded wages and employer tax exactly; investigate before writing.`,
      );
    }
  }
  return out;
}

/** Readable, non-blocking notes about periods whose delta IS accounted for. */
function notes(rows: BackfillPeriodResult[]): string[] {
  return rows.filter(isExplained).map((r) => {
    const causes: string[] = [];
    if (recoveredCents(r) > 0) {
      causes.push(
        `${formatCurrencyCents(recoveredCents(r))} from ${r.recoveredAccounts.length} wage account(s) present in the CSV but missing from the stored totals — the report was uploaded before that department was mapped, so its wages were dropped`,
      );
    }
    if (newlyRecognisedCents(r) > 0) {
      const labels = (r.wageSubRowTotals ?? [])
        .filter((t) => LABELS_THE_OLD_PARSER_DROPPED.has(t.label))
        .map((t) => `${t.label} ${formatCurrencyCents(t.amountCents)}`)
        .join(", ");
      causes.push(
        `${formatCurrencyCents(newlyRecognisedCents(r))} from pay types the parser used to drop (${labels})`,
      );
    }
    return `Period ${r.payPeriodId.slice(0, 8)}: non-tip payroll rises ${formatCurrencyCents(explainedCents(r))} — ${causes.join("; and ")}. The backfill restores it.`;
  });
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
            {notes(rows).length > 0 && (
              <Banner tone="info" className="mb-3">
                <ul className="list-disc ml-4">
                  {notes(rows).map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </Banner>
            )}
            <LedgerTable
              head={
                <>
                  <Th label="Pay period" />
                  <Th label="Non-tip before" align="right" />
                  <Th label="Non-tip after" align="right" />
                  <Th label="Wages" align="right" />
                  <Th label="Employer tax" align="right" />
                  <Th label="Tips (new)" align="right" />
                  <Th label="" />
                </>
              }
            >
              {rows.map((r) => (
                <tr key={r.reportId} className="border-b border-line-subtle last:border-0">
                  <td className="px-4 py-2 text-body">{label(r.payPeriodId)}</td>
                  <td className="px-4 py-2 text-right text-body tabular-nums">
                    {formatCurrencyCents(nonTips(r.before))}
                  </td>
                  <td className="px-4 py-2 text-right text-body tabular-nums">
                    {formatCurrencyCents(nonTips(r.after))}
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
                    ) : isExplained(r) ? (
                      <Badge tone="info">
                        {mode === "applied" ? "Wages restored" : `Restores ${formatCurrencyCents(explainedCents(r))}`}
                      </Badge>
                    ) : nonTips(r.before) !== nonTips(r.after) ? (
                      <Badge tone="danger">Non-tip payroll changed</Badge>
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
              &ldquo;Non-tip before&rdquo; and &ldquo;Non-tip after&rdquo; must match on every row,
              unless the difference is itemised in a note above — wages the upload dropped before
              the department was mapped, or a pay type the parser did not yet recognise. Anything
              else blocks the write. Tips sit in their own bucket, so the grand total is expected to
              grow by the Tips column on any period that predates it. What must not move on its own
              is wages plus employer tax: the backfill may split a lump &ldquo;wages&rdquo; row into
              its two parts, but it cannot change what they sum to.
            </p>
          </>
        )
      }
    </BackfillShell>
  );
}
