"use client";
// Finance > Period Close > <period> — the per-period work surface.
//
// Validates the route param against `monthEnd` (any period that isn't a real
// month-end date bounces back to the index — there is nothing to show for a
// half-month) and renders the same one-line status summary the checklist
// panel used to print in its own header, followed by the checklist itself.

import { useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import { usePermissions } from "@/lib/hooks/useUserRole";
import { CAP } from "@/lib/auth/capabilities";
import { monthEnd } from "@/lib/finance/manualEntries";
import { formatPeriodLabel, type CloseTasksResponse } from "../../closeTasks";
import PeriodClosePanel from "../PeriodClosePanel";

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function PeriodCloseDetailPage() {
  const { periodEnd } = useParams<{ periodEnd: string }>();
  const router = useRouter();
  const { can } = usePermissions();
  const canManage = can(CAP.financeTransactionsManage);

  const valid = periodEnd === monthEnd(periodEnd);

  useEffect(() => {
    if (!valid) router.replace("/finance/period-close");
  }, [valid, router]);

  const { data } = useQuery({
    queryKey: queryKeys.finance.balanceClose(periodEnd),
    queryFn: () => fetchJson<CloseTasksResponse>(`/api/finance/balance-close?periodEnd=${periodEnd}`),
    enabled: valid,
  });

  // Bouncing on an invalid param; render nothing while that redirect lands.
  if (!valid) return null;

  const tasks = data?.tasks ?? [];
  const open = tasks.filter((t) => t.status === "open");
  const closed = data?.close?.closed ?? false;
  // The steps a person has to do themselves: balances and duplicates. The
  // recalculation is the app's to get right, and its own step says where it
  // stands, so it is not counted as work for the reader here.
  const left = (open.length > 0 ? 1 : 0) + ((data?.unreviewedDuplicates ?? 0) > 0 ? 1 : 0);
  const label = formatPeriodLabel(periodEnd);

  return (
    <div className="px-4 sm:px-6 py-4 sm:py-8 flex flex-col gap-4">
      <Link href="/finance/period-close" className="text-2xs text-faint hover:text-accent-soft w-fit">
        ← All periods
      </Link>

      <div>
        <h2 className="text-sm text-strong">{label}</h2>
        <p className="text-xs text-secondary mt-0.5">
          {closed
            ? "Closed."
            : left > 0
              ? `${left} step${left === 1 ? "" : "s"} below need${left === 1 ? "s" : ""} you before this month can close.`
              : "Nothing below is waiting on you. Read steps 3 and 4, then close the month."}
          {data?.dueDate && !closed ? ` Due ${fmtDate(data.dueDate)}.` : ""}
        </p>
      </div>

      <PeriodClosePanel periodEnd={periodEnd} canManage={canManage} />
    </div>
  );
}
