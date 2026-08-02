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
  // Nothing was ever asked for in this period. Saying so beats an empty box,
  // because "no tasks" and "all done" are different states and only one of
  // them is worth feeling good about.
  const nothingAsked = tasks.length === 0;
  const label = formatPeriodLabel(periodEnd);

  return (
    <div className="px-4 sm:px-6 py-4 sm:py-8 flex flex-col gap-4">
      <Link href="/finance/period-close" className="text-2xs text-faint hover:text-accent-soft w-fit">
        ← All periods
      </Link>

      <div>
        <h2 className="text-sm text-strong">{label}</h2>
        <p className="text-2xs text-faint mt-0.5">
          {nothingAsked
            ? "No account is set to need a hand-entered balance for this month."
            : open.length > 0
              ? `${open.length} account${open.length === 1 ? "" : "s"} still need${open.length === 1 ? "s" : ""} a balance.`
              : "Every account has been answered."}
          {data?.dueDate && !nothingAsked ? ` The period is due ${fmtDate(data.dueDate)}.` : ""}
        </p>
      </div>

      <PeriodClosePanel periodEnd={periodEnd} canManage={canManage} />
    </div>
  );
}
