"use client";
import { Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import TabBar, { type TabDef } from "@/app/components/TabBar";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import IntakeTab from "@/app/production/components/IntakeTab";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { needsBatch } from "@/app/production/components/intake/PlanTab";
import { PARTNER_REQUESTS_QUERY_KEY } from "@/app/production/components/intake/PartnerRequestsTab";
import type { PlanRow } from "@/lib/production/intakeDemand.server";

export type IntakeSubtab = "plan" | "commitments";

// Left to right follows the work: deals come in, then they get planned.
const TAB_ORDER: IntakeSubtab[] = ["commitments", "plan"];

/** The tab lives in the URL (?tab=plan) so other pages can link to it. */
function IntakeContent() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const sub: IntakeSubtab = params.get("tab") === "plan" ? "plan" : "commitments";
  const setSub = (key: IntakeSubtab) => router.replace(key === "commitments" ? pathname : `${pathname}?tab=${key}`, { scroll: false });

  // Counts on the tabs, so work waiting on the OTHER tab is never out of sight.
  // Same queries (and cache) the tabs themselves use.
  const { data: plan } = useQuery({
    queryKey: queryKeys.production.demandCalendar(),
    queryFn: () => fetchJson<{ rows: PlanRow[] }>("/api/production/demand-calendar"),
    staleTime: 5 * 60 * 1000,
  });
  const { data: requests } = useQuery({
    queryKey: PARTNER_REQUESTS_QUERY_KEY,
    queryFn: () => fetchJson<Array<{ status: string }>>("/api/production/partner-requests"),
  });
  const toBrew = (plan?.rows ?? []).filter(needsBatch).length;
  const toDecide = (requests ?? []).filter((r) => r.status === "submitted").length;
  const count = (n: number) => (n > 0 ? ` (${n})` : "");
  const labels: Record<IntakeSubtab, string> = {
    commitments: `Commitments${count(toDecide)}`,
    plan: `Plan${count(toBrew)}`,
  };
  const tabs: TabDef<IntakeSubtab>[] = TAB_ORDER.map((key) => ({ key, label: labels[key] }));

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader
          title="Intake"
          description="What to brew next, and who it is for"
        />
        <TabBar tabs={tabs} activeKey={sub} onSelect={setSub} className="mb-0" />
      </StickyHeader>
      <div className="mt-6 pb-4 sm:pb-8"><IntakeTab sub={sub} /></div>
    </main>
  );
}

export default function IntakePage() {
  return <Suspense><IntakeContent /></Suspense>;
}
