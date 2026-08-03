// Server half of the Financials page: resolve which statement/year the browser
// is about to ask for, build it here, and hand it over already-fetched.
//
// The page body is FinancialsClient.tsx and still owns every bit of interaction
// -- switching statement or year issues a normal client fetch. All this does is
// remove the FIRST one from the critical path. That fetch used to wait for the
// route's JS to download, parse and hydrate before it could even be issued
// (~1.8s in production), and only then spent another ~1s on the round trip.
//
// This does not block the paint, because loading.tsx wraps this component in a
// Suspense boundary: Next flushes the layout plus that skeleton immediately and
// streams the resolved statement in behind it. Without the skeleton this would
// be a straight trade of a blank screen for a faster number, which is not a
// trade worth making.
//
// buildFinancials is called directly rather than fetching our own
// /api/finance/financials -- same code, one less HTTP hop. The route handler
// stays because the client still uses it. Authorization is not skipped: the
// layout above awaits requirePage(CAP.financeStatementsRead) before this
// component renders at all.

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { createServerQueryClient } from "@/lib/query-server";
import { buildFinancials } from "@/lib/finance/financials";
import type { StatementKind } from "@/lib/finance/financials/types";
import { localDateString } from "@/lib/utils/datetime";
import FinancialsClient from "./FinancialsClient";

const VALID_STATEMENTS: StatementKind[] = ["pl", "balance_sheet", "cash_flow"];

/**
 * Reads the `?statement=` param the old /finance/statements redirects preserve.
 * Typed against what Next actually hands over -- a repeated param arrives as an
 * array, which is not a StatementKind and falls through to the P&L default.
 */
function initialStatementFrom(param: string | string[] | undefined): StatementKind {
  return VALID_STATEMENTS.includes(param as StatementKind) ? (param as StatementKind) : "pl";
}

/**
 * The current year in the taproom's zone, not the server's. This runs on Vercel
 * in UTC, so a plain getFullYear() would roll over five hours early and prefetch
 * next year's (empty) statement on New Year's Eve -- and disagree with the year
 * the client would have picked, wasting the prefetch on the one evening a year
 * it is hardest to notice.
 */
function breweryYear(): number {
  return Number(localDateString(new Date().toISOString()).slice(0, 4));
}

export default async function FinancialsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { statement: statementParam } = await searchParams;
  const statement = initialStatementFrom(statementParam);
  const year = breweryYear();

  const queryClient = createServerQueryClient();
  // prefetchQuery swallows failures by design. A statement that throws here is
  // simply absent from the dehydrated cache, the client falls through to its
  // normal fetch, and the page's existing error banner reports it -- a broken
  // prefetch costs latency, never the screen.
  await queryClient.prefetchQuery({
    queryKey: queryKeys.finance.financials(statement, year),
    queryFn: () => buildFinancials({ statement, year }),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <FinancialsClient initialStatement={statement} initialYear={year} />
    </HydrationBoundary>
  );
}
