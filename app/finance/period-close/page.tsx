"use client";
// Finance > Period Close — the periods index.
//
// One row per recent month end, each fetched independently (useQueries, not
// one combined request) so a slow or still-loading period never blocks the
// others from rendering, and a single bad period can't take the whole table
// down. This is the "which months need attention" view; the checklist and
// the close/reopen act live one level down at /finance/period-close/<period>.

import Link from "next/link";
import { useQueries, useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import {
  balancingDifferenceFor,
  formatPeriodLabel,
  recalculationCheck,
  recentMonthEnds,
  type CloseTasksResponse,
} from "../closeTasks";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import { formatBalanceCents } from "@/lib/format";
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
  const duplicates = data.unreviewedDuplicates;
  // The same payment recorded from two feeds. It blocks the close exactly as an
  // outstanding balance does, so it is counted in the same cell and links to
  // where it is answered.
  const duplicatesLine = duplicates > 0 && (
    <Link href="/finance/transactions/duplicates" className="block text-body hover:text-accent">
      {duplicates} possible duplicate{duplicates === 1 ? "" : "s"} to review
    </Link>
  );

  // The third thing a close refuses on. It was missing from this list, so the
  // index could say "All answered" for a month whose Close button was disabled.
  const failing = !(data.close?.closed ?? false) && recalculationCheck(data.recalculation).state === "failing";
  const recalculationLine = failing && <span className="block text-danger">Recalculation failed</span>;

  if (data.tasks.length === 0) {
    return duplicatesLine || recalculationLine ? (
      <>
        {duplicatesLine}
        {recalculationLine}
      </>
    ) : (
      DASH
    );
  }
  const openCount = data.tasks.filter((t) => t.status === "open").length;
  return (
    <>
      {openCount === 0 ? (
        <span className="text-2xs text-faint">All answered</span>
      ) : (
        <span className="text-body">
          {openCount} balance{openCount === 1 ? "" : "s"} outstanding
        </span>
      )}
      {duplicatesLine}
      {recalculationLine}
    </>
  );
}

/**
 * The period's Balancing Difference, straight off its stored snapshot — the
 * same figure the balance sheet's bottom row shows for that month. Zero is
 * the goal state and renders quietly; anything else is the money still
 * unaccounted for, and is what closing this month is meant to drive out.
 */
function BalancingDifferenceCell({ data }: { data: CloseTasksResponse }) {
  const { cents, basis } = balancingDifferenceFor(data);
  if (cents === null) return DASH;
  if (cents === 0) return <span className="text-2xs text-faint">{formatBalanceCents(0)}</span>;
  // Not red. A closed month's difference is a figure somebody signed, and an
  // open month's is a figure to read; red on every row made the whole column
  // look like an error, including months closed with a written explanation.
  return <span className={basis === "closed" ? "text-body" : "text-accent"}>{formatBalanceCents(cents)}</span>;
}

function CoverageCell({ data }: { data: CloseTasksResponse }) {
  const { configured, withBalance, missing } = data.coverage;
  if (configured === 0) return <span className="text-2xs text-faint">Nothing configured</span>;
  return (
    <>
      <span className="text-body">
        {withBalance} account{withBalance === 1 ? "" : "s"} with a balance
      </span>
      {/* Only the accounts that HAD a figure and lost it. Accounts that have
          never been used are not a gap and are not counted against the month. */}
      {missing.length > 0 && (
        <span className="block text-accent">
          {missing.length} that had one before {missing.length === 1 ? "has" : "have"} none
        </span>
      )}
    </>
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
  // Every month still open, however old, plus the recent ones for context. The
  // list used to be the last six months only, so a month left open long enough
  // would have dropped off the one screen that exists to close it.
  const { data: openList } = useQuery({
    queryKey: queryKeys.finance.balanceClosePeriods(),
    queryFn: () => fetchJson<{ open: string[] }>("/api/finance/balance-close/periods"),
  });
  const open = openList?.open ?? [];
  const periods = Array.from(new Set([...recentMonthEnds(6), ...open])).sort().reverse();
  const oldestOpen = open[0];

  const results = useQueries({
    queries: periods.map((p) => ({
      queryKey: queryKeys.finance.balanceClose(p),
      queryFn: () => fetchJson<CloseTasksResponse>(`/api/finance/balance-close?periodEnd=${p}`),
    })),
  });

  return (
    <div className="px-4 sm:px-6 py-4 sm:py-8 flex flex-col gap-4">
      {/* The one thing to do next, said once. Oldest first because an earlier
          month that is still open can still change, and every later month
          starts from it. */}
      {openList &&
        (oldestOpen ? (
          <Banner tone="info">
            {open.length === 1
              ? `${formatPeriodLabel(oldestOpen)} is not closed yet.`
              : `${open.length} months are not closed yet. Start with the oldest.`}{" "}
            <Link href={`/finance/period-close/${oldestOpen}`} className="underline hover:text-accent">
              Open {formatPeriodLabel(oldestOpen)}
            </Link>
          </Banner>
        ) : (
          <p className="text-xs text-secondary">Every month that has ended is closed. Nothing to do here.</p>
        ))}
      <LedgerTable
        head={
          <>
            <Th label="Period" />
            <Th label="Status" />
            <Th label="Outstanding" />
            <Th label="Accounts" />
            <Th label="Balancing difference" />
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
              <td className="px-4 py-2 whitespace-nowrap">{isLoading || !data ? LOADING : <BalancingDifferenceCell data={data} />}</td>
              <td className="px-4 py-2">{isLoading || !data ? LOADING : <ClosedByCell data={data} />}</td>
            </tr>
          );
        })}
      </LedgerTable>
    </div>
  );
}
