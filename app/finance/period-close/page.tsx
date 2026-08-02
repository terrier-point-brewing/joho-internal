"use client";
// Finance > Period Close — the periods index.
//
// One row per recent month end, each fetched independently (useQueries, not
// one combined request) so a slow or still-loading period never blocks the
// others from rendering, and a single bad period can't take the whole table
// down. This is the "which months need attention" view; the checklist and
// the close/reopen act live one level down at /finance/period-close/<period>.

import Link from "next/link";
import { useQueries } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import { formatPeriodLabel, recentMonthEnds, type CloseTasksResponse } from "../closeTasks";
import Badge from "@/app/components/ui/Badge";
import { LedgerTable, Th } from "../transactions/components/LedgerTable";

const DASH = <span className="text-faint">—</span>;
const LOADING = <span className="text-2xs text-faint">Loading…</span>;

/** "2 Aug 2026, 4:12 pm" — matches PeriodClosePanel's fmtMoment. */
function fmtMoment(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function StatusCell({ data }: { data: CloseTasksResponse }) {
  const isClosed = data.close?.closed ?? false;
  return <Badge tone={isClosed ? "success" : "neutral"}>{isClosed ? "Closed" : "Open"}</Badge>;
}

/**
 * "2 balances outstanding", or a dash when nothing was ever asked for this
 * period. Distinct from "All answered" (tasks exist and every one has a
 * status), because a quiet month and a finished month are different claims —
 * the same distinction the checklist panel makes with its own `nothingAsked`.
 */
function OutstandingCell({ data }: { data: CloseTasksResponse }) {
  if (data.tasks.length === 0) return DASH;
  const openCount = data.tasks.filter((t) => t.status === "open").length;
  if (openCount === 0) return <span className="text-2xs text-faint">All answered</span>;
  return (
    <span className="text-body">
      {openCount} balance{openCount === 1 ? "" : "s"} outstanding
    </span>
  );
}

function CoverageCell({ data }: { data: CloseTasksResponse }) {
  const { configured, withBalance } = data.coverage;
  if (configured === 0) return <span className="text-2xs text-faint">Nothing configured</span>;
  return (
    <span className="text-body">
      {withBalance} of {configured} account{configured === 1 ? "" : "s"} produced a balance
    </span>
  );
}

/**
 * Who closed the period (or, if it's open again after having been closed,
 * who reopened it and when) — the same two facts ClosePeriodFooter renders,
 * condensed to one line for the table.
 */
function ClosedByCell({ data }: { data: CloseTasksResponse }) {
  const close = data.close;
  if (!close) return DASH;
  const who = close.actorEmail ?? "somebody whose login has since been removed";
  if (close.closed) {
    return (
      <span className="text-2xs text-faint">
        {who} on {fmtMoment(close.at)}
      </span>
    );
  }
  if (close.action === "reopened") {
    return (
      <span className="text-2xs text-faint">
        Reopened by {who} on {fmtMoment(close.at)}
      </span>
    );
  }
  return DASH;
}

export default function PeriodClosePage() {
  const periods = recentMonthEnds(6);

  const results = useQueries({
    queries: periods.map((p) => ({
      queryKey: queryKeys.finance.balanceClose(p),
      queryFn: () => fetchJson<CloseTasksResponse>(`/api/finance/balance-close?periodEnd=${p}`),
    })),
  });

  return (
    <div className="px-4 sm:px-6 py-4 sm:py-8">
      <LedgerTable
        head={
          <>
            <Th label="Period" />
            <Th label="Status" />
            <Th label="Outstanding" />
            <Th label="Coverage" />
            <Th label="Closed by" />
          </>
        }
      >
        {periods.map((p, i) => {
          const { data, isLoading } = results[i];
          return (
            <tr key={p} className="border-b border-line last:border-0 hover:bg-surface-mid/30">
              <td className="px-4 py-2 whitespace-nowrap">
                <Link href={`/finance/period-close/${p}`} className="text-strong hover:text-accent font-medium">
                  {formatPeriodLabel(p)}
                </Link>
              </td>
              <td className="px-4 py-2">{isLoading || !data ? LOADING : <StatusCell data={data} />}</td>
              <td className="px-4 py-2">{isLoading || !data ? LOADING : <OutstandingCell data={data} />}</td>
              <td className="px-4 py-2">{isLoading || !data ? LOADING : <CoverageCell data={data} />}</td>
              <td className="px-4 py-2">{isLoading || !data ? LOADING : <ClosedByCell data={data} />}</td>
            </tr>
          );
        })}
      </LedgerTable>
    </div>
  );
}
