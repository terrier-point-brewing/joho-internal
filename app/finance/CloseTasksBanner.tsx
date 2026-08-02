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

  // A finished month nobody has closed. This is the state the change to a human
  // close deliberately made visible: the cron used to freeze such a month on the
  // operator's behalf, so "somebody signed this off" and "the 5th went by" were
  // indistinguishable afterwards. Held back until the period's own deadline
  // arrives, so it reads as "the books are due and unsigned" rather than
  // nagging from the 1st.
  const readyAndDue =
    open.length === 0 && (data?.readyToClose ?? false) && !!data && todayIso() >= data.dueDate;

  if (open.length === 0 && !readyAndDue) return null;

  // Silent on the screen it points at, where the full checklist is already on
  // display. A banner telling you to go where you are is noise.
  if (pathname === ENTRY_PATH) return null;

  const label = formatPeriodLabel(periodEnd);

  if (readyAndDue) {
    return (
      <Banner tone="info" className="mx-4 sm:mx-6 mb-4 mt-4">
        Every account has been answered for {label}, but nobody has closed the month — its balances are still
        recomputing.{" "}
        <a href={`${ENTRY_PATH}?periodEnd=${periodEnd}`} className="underline">
          Close it in Manual Entries
        </a>
        .
      </Banner>
    );
  }

  // The earliest deadline among the outstanding accounts, not the period's:
  // accounts may carry their own allowance, and the one that bites first is the
  // only date worth putting in a one-line nudge.
  const soonest = open.reduce((a, t) => (t.dueDate < a ? t.dueDate : a), open[0].dueDate);

  return (
    <Banner tone="info" className="mx-4 sm:mx-6 mb-4 mt-4">
      {open.length} balance-sheet account{open.length === 1 ? "" : "s"} still need
      {open.length === 1 ? "s" : ""} a {label} balance, from {soonest}.{" "}
      <a href={`${ENTRY_PATH}?periodEnd=${periodEnd}`} className="underline">
        Enter them in Manual Entries
      </a>
      .
    </Banner>
  );
}

/** Today in the viewer's own zone, which is the brewery's. Compared only against a date string. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
