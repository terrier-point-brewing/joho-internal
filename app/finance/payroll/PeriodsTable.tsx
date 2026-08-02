"use client";

// Standard periods table for Finance → Payroll. Presentation only; per-period
// rollups are computed server-side (lib/payroll/periodSummary.ts) and sort/filter
// state is owned by the parent via useTableControls.

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

function Money({ cents }: { cents: number | null }) {
  if (cents === null) return DASH;
  return <span className="text-body tabular-nums">{formatCurrencyCents(cents)}</span>;
}

/** Drift / reconciliation cell: green "OK" within tolerance, red signed variance otherwise, dash when N/A. */
function Variance({ cents }: { cents: number | null }) {
  if (cents === null) return DASH;
  if (withinTolerance(cents)) return <Badge tone="success">OK</Badge>;
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
      head={
        <>
          <SortableTh label="Period" sortKey="period" sort={sort} onSort={onSort} className="!px-4 !py-2 !text-muted" />
          <SortableTh label="Due Date" sortKey="due" sort={sort} onSort={onSort} className="!px-4 !py-2 !text-muted" />
          <Th label="Status" />
          <Th label="Employees" align="right" />
          <SortableTh label="App Wages" sortKey="basis" sort={sort} onSort={onSort} align="right" className="!px-4 !py-2 !text-muted" />
          <Th label="Cash Tips" align="right" />
          <SortableTh label="Gusto Wages" sortKey="gusto" sort={sort} onSort={onSort} align="right" className="!px-4 !py-2 !text-muted" />
          <Th label="Employer Taxes" align="right" />
          <Th label="Drift" align="right" />
          <Th label="Matched Transactions" align="right" />
          <Th label="Reconciliation" align="right" />
          <Th label="Split Status" align="center" />
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
            <td className="px-4 py-2 whitespace-nowrap">
              <Link href={`/finance/payroll/${p.id}`} className="text-strong hover:text-accent">
                {p.start_date} – {p.end_date}
              </Link>
            </td>
            <td className="px-4 py-2 whitespace-nowrap text-body">{p.due_date ?? DASH}</td>
            <td className="px-4 py-2">
              <Badge tone={p.status === "locked" ? "neutral" : "accent"}>
                {p.status === "locked" ? "Locked" : "Open"}
              </Badge>
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {p.entryCount > 0 ? p.entryCount : DASH}
            </td>
            <td className="px-4 py-2 text-right" title={p.status === "locked" ? undefined : "Wages are snapshotted when the period is locked"}>
              <Money cents={p.appWagesCents} />
            </td>
            <td className="px-4 py-2 text-right" title="Kept by staff directly — never disbursed by Gusto">
              <Money cents={p.appCashTipsCents} />
            </td>
            <td className="px-4 py-2 text-right" title={p.reportFilename ?? undefined}>
              <div className="flex flex-col items-end leading-tight">
                <Money cents={p.gustoWagesCents} />
                {p.reportUploadedAt && (
                  <span className="text-2xs text-faint">{fmtDate(p.reportUploadedAt)}</span>
                )}
              </div>
            </td>
            <td className="px-4 py-2 text-right">
              <Money cents={p.gustoEmployerTaxCents} />
            </td>
            <td className="px-4 py-2 text-right">
              <Variance cents={p.driftCents} />
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {p.matchedCount > 0 ? (
                <span className="text-body">
                  {p.matchedCount} · {formatCurrencyCents(p.matchedSumCents)}
                </span>
              ) : (
                DASH
              )}
            </td>
            <td className="px-4 py-2 text-right">
              <Variance cents={p.reconciliationCents} />
            </td>
            <td className="px-4 py-2 text-center">
              <SplitCell status={p.splitStatus} />
            </td>
          </tr>
        ))
      )}
    </LedgerTable>
  );
}
