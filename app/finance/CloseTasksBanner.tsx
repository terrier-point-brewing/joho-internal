"use client";
// The month-end close nudge: "N accounts still need a balance for July".
//
// Lifted out of the Financials page, where it was the only place this ever
// appeared. That was the wrong single home for it. The work it describes is
// done under Finance > Transactions, and the alert email sends people there --
// so the one screen someone lands on with this outstanding was the one screen
// that never mentioned it.
//
// It renders nothing at all when nothing is outstanding, which is the normal
// state, so it costs a reader nothing to have it on more than one surface.

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import Banner from "@/app/components/ui/Banner";
import { priorMonthEnd, formatPeriodLabel, type CloseTasksResponse } from "./closeTasks";

const ENTRY_PATH = "/finance/transactions/manual-entries";

export default function CloseTasksBanner() {
  const pathname = usePathname();
  const periodEnd = useMemo(() => priorMonthEnd(), []);

  const { data } = useQuery({
    queryKey: queryKeys.finance.balanceClose(periodEnd),
    queryFn: () => fetchJson<CloseTasksResponse>(`/api/finance/balance-close?periodEnd=${periodEnd}`),
    // This route needs a statements capability, which someone with only
    // transactions access does not hold. Their answer is a 403 and it will
    // still be a 403 on the third attempt; the banner simply stays hidden.
    retry: false,
  });

  const open = data?.tasks.filter((t) => t.status === "open") ?? [];
  if (open.length === 0) return null;

  // Silent on the screen it points at, where the full checklist is already on
  // display. A banner telling you to go where you are is noise.
  if (pathname === ENTRY_PATH) return null;

  // The earliest deadline among the outstanding accounts, not the period's:
  // accounts may carry their own allowance, and the one that bites first is the
  // only date worth putting in a one-line nudge.
  const soonest = open.reduce((a, t) => (t.dueDate < a ? t.dueDate : a), open[0].dueDate);

  return (
    <Banner tone="info" className="mx-4 sm:mx-6 mb-4 mt-4">
      {open.length} balance-sheet account{open.length === 1 ? "" : "s"} still need
      {open.length === 1 ? "s" : ""} a {formatPeriodLabel(periodEnd)} balance, from {soonest}.{" "}
      <a href={`${ENTRY_PATH}?periodEnd=${periodEnd}`} className="underline">
        Enter them in Manual Entries
      </a>
      .
    </Banner>
  );
}
