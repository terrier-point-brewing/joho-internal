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

/**
 * The two checks as one answer. "Balanced" when every check that could run is
 * within tolerance; the signed gap(s) otherwise; a dash when neither could run.
 * What each check needs, and which one is missing, lives in the tooltip rather
 * than in a column of its own.
 */
const CHECKS: { key: "reconciliationCents" | "taproomVarianceCents"; label: string; needs: string }[] = [
  { key: "reconciliationCents", label: "Bank vs Gusto", needs: "a Gusto report and a matched bank transaction" },
  { key: "taproomVarianceCents", label: "Shifts vs Gusto", needs: "a locked period, a Gusto report, and a taproom wages account" },
];

function Reconciled({ p }: { p: PayPeriodSummary }) {
  const ran = CHECKS.filter((c) => p[c.key] !== null);
  const missing = CHECKS.filter((c) => p[c.key] === null);
  const title = [
    ...ran.map((c) => `${c.label}: ${withinTolerance(p[c.key]!) ? "balanced" : formatCurrencyCents(p[c.key]!)}`),
    ...missing.map((c) => `${c.label}: needs ${c.needs}`),
  ].join("\n");
  if (ran.length === 0) return <span title={title}>{DASH}</span>;
  const gaps = ran.filter((c) => !withinTolerance(p[c.key]!));
  if (gaps.length === 0) return <Badge tone="success" title={title}>Balanced{missing.length > 0 ? " *" : ""}</Badge>;
  return (
    <Badge tone="danger" title={title}>
      {gaps.map((c) => formatCurrencyCents(p[c.key]!)).join(" · ")}
    </Badge>
  );
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
            colSpan={3}
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
          <Th label="Reconciled" align="right" className="!px-3" />
          <Th label="Split" align="center" className="!px-3" />
        </>
      }
    >
      {rows.length === 0 ? (
        <tr>
          <td colSpan={11} className="py-6 text-center text-faint">
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
              title="Wages for staff on Square shifts — the bucket the app can check"
            >
              <Money cents={p.gustoTaproomWagesCents} />
            </td>
            <td className="px-3 py-2 text-right" title="Salaried staff — no shift data, never checked">
              <Money cents={p.gustoSalariedWagesCents} />
            </td>
            <td className="px-3 py-2 text-right" title="Paycheck tips — part of the bank debit">
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
              <Reconciled p={p} />
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
