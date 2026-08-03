"use client";

// Standard periods table for Finance → Payroll. Presentation only; per-period
// rollups are computed server-side (lib/payroll/periodSummary.ts) and sort/filter
// state is owned by the parent via useTableControls.
//
// The columns are banded so the arithmetic is visible rather than implied:
// Taproom + Salaried + Tips + Taxes = Total, and Total is what the bank debits
// should equal. Splitting Gusto's wages into the taproom slice (which the app
// can check against Square shifts) and the salaried slice (which it can't) is
// what keeps the variance columns comparing like with like — without it,
// ~$4,700/period of salaried payroll lands in a variance it has no business in.

import Link from "next/link";
import { LedgerTable, Th } from "@/app/finance/transactions/components/LedgerTable";
import SortableTh from "@/app/components/ui/SortableTh";
import Badge from "@/app/components/ui/Badge";
import { formatCurrencyCents } from "@/lib/format";
import { fmtDate } from "@/lib/utils/formatting";
import { withinTolerance } from "@/lib/payroll/periodSummary";
import type { PayPeriodSummary } from "@/lib/payroll/types";
import type { SortState } from "@/lib/table/types";

const DASH = <span className="text-faint">—</span>;

/** Left edge of a column band. */
const BAND = "border-l border-line";

function Money({ cents, className = "" }: { cents: number | null; className?: string }) {
  if (cents === null) return DASH;
  return <span className={`text-body tabular-nums ${className}`.trim()}>{formatCurrencyCents(cents)}</span>;
}

/** A check result: "Balanced" within tolerance, the signed gap otherwise, dash
 *  when the check can't run (missing report, missing matches, unlocked period). */
function Check({ cents, title }: { cents: number | null; title?: string }) {
  if (cents === null) return <span title={title}>{DASH}</span>;
  if (withinTolerance(cents)) return <Badge tone="success">Balanced</Badge>;
  return <Badge tone="danger">{formatCurrencyCents(cents)}</Badge>;
}

function SplitCell({ status }: { status: PayPeriodSummary["splitStatus"] }) {
  if (status === "split") return <Badge tone="success">Split</Badge>;
  if (status === "awaiting") return <Badge tone="accent">Awaiting</Badge>;
  return DASH;
}

export default function PeriodsTable({
  rows,
  sort,
  onSort,
}: {
  rows: PayPeriodSummary[];
  sort: SortState;
  onSort: (key: string) => void;
}) {
  return (
    <LedgerTable
      groupHead={
        <>
          <th colSpan={3} className="px-3 py-1.5 text-left text-2xs font-medium text-faint uppercase tracking-wide">
            Period
          </th>
          <th
            colSpan={5}
            className={`px-3 py-1.5 text-center text-2xs font-medium text-secondary uppercase tracking-wide ${BAND}`}
          >
            What Gusto says payroll cost
          </th>
          <th
            colSpan={4}
            className={`px-3 py-1.5 text-center text-2xs font-medium text-faint uppercase tracking-wide ${BAND}`}
          >
            Checks
          </th>
        </>
      }
      head={
        <>
          <SortableTh label="Dates" sortKey="period" sort={sort} onSort={onSort} className="!px-3 !py-2 !text-muted" />
          <SortableTh label="Due Date" sortKey="due" sort={sort} onSort={onSort} className="!px-3 !py-2 !text-muted" />
          <Th label="Status" className="!px-3" />
          <SortableTh
            label="Taproom"
            sortKey="taproom"
            sort={sort}
            onSort={onSort}
            align="right"
            className={`!px-3 !py-2 !text-muted ${BAND}`}
          />
          <Th label="Salaried" align="right" className="!px-3" />
          <Th label="Tips" align="right" className="!px-3" />
          <Th label="Taxes" align="right" className="!px-3" />
          <SortableTh
            label="Total"
            sortKey="total"
            sort={sort}
            onSort={onSort}
            align="right"
            className="!px-3 !py-2 !text-body"
          />
          <Th label="Bank" align="right" className={`!px-3 ${BAND}`} />
          <Th label="Bank vs Gusto" align="right" className="!px-3" />
          <Th label="Taproom vs app" align="right" className="!px-3" />
          <Th label="Split" align="center" className="!px-3" />
        </>
      }
    >
      {rows.length === 0 ? (
        <tr>
          <td colSpan={12} className="py-6 text-center text-faint">
            No pay periods yet.
          </td>
        </tr>
      ) : (
        rows.map((p) => (
          <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-mid/30">
            <td className="px-3 py-2 whitespace-nowrap">
              <Link href={`/finance/payroll/${p.id}`} className="text-strong hover:text-accent">
                {p.start_date} – {p.end_date}
              </Link>
            </td>
            <td className="px-3 py-2 whitespace-nowrap text-body">{p.due_date ?? DASH}</td>
            <td className="px-3 py-2">
              <Badge tone={p.status === "locked" ? "neutral" : "accent"}>
                {p.status === "locked" ? "Locked" : "Open"}
              </Badge>
            </td>

            <td
              className={`px-3 py-2 text-right ${BAND}`}
              title="Wages for staff the app tracks via Square shifts — the only wage bucket it can check"
            >
              <Money cents={p.gustoTaproomWagesCents} />
            </td>
            <td className="px-3 py-2 text-right" title="Salaried brewery and admin staff — no shift data, so shown but never checked">
              <Money cents={p.gustoSalariedWagesCents} />
            </td>
            <td className="px-3 py-2 text-right" title="Paycheck tips — a balance-sheet pass-through, but real money in the bank debit">
              <Money cents={p.gustoTipsCents} />
            </td>
            <td className="px-3 py-2 text-right">
              <Money cents={p.gustoEmployerTaxCents} />
            </td>
            <td className="px-3 py-2 text-right" title={p.reportFilename ?? undefined}>
              <div className="flex flex-col items-end leading-tight">
                <Money cents={p.gustoTotalCents} className="font-medium text-strong" />
                {p.reportUploadedAt && (
                  <span className="text-2xs text-faint">{fmtDate(p.reportUploadedAt)}</span>
                )}
              </div>
            </td>

            <td className={`px-3 py-2 text-right tabular-nums ${BAND}`}>
              {p.matchedCount > 0 ? (
                <span className="text-body">
                  {p.matchedCount} · {formatCurrencyCents(p.matchedSumCents)}
                </span>
              ) : (
                DASH
              )}
            </td>
            <td className="px-3 py-2 text-right">
              <Check cents={p.reconciliationCents} title="Needs a Gusto report and at least one matched transaction" />
            </td>
            <td className="px-3 py-2 text-right">
              <Check
                cents={p.taproomVarianceCents}
                title="Needs a locked period, a Gusto report, and a taproom wages account in Settings"
              />
            </td>
            <td className="px-3 py-2 text-center">
              <SplitCell status={p.splitStatus} />
            </td>
          </tr>
        ))
      )}
    </LedgerTable>
  );
}
