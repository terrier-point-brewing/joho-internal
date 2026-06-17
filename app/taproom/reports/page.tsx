"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import SubNav from "@/app/components/SubNav";
import { TAPROOM_NAV } from "@/app/taproom/nav-config";
import { useUserRole } from "@/lib/hooks/useUserRole";
import CocktailSalesReport   from "@/app/reports/components/CocktailSalesReport";
import KegSalesReport        from "@/app/reports/components/KegSalesReport";
import TaproomModelReport    from "@/app/reports/components/TaproomModelReport";
import GiftCardReport        from "@/app/reports/components/GiftCardReport";
import ContractBrewingReport from "@/app/reports/components/ContractBrewingReport";
import DistributionReport    from "@/app/reports/components/DistributionReport";
import BBLTrackerReport      from "@/app/reports/components/BBLTrackerReport";

const REPORT_GROUPS = [
  {
    id: "net-sales",
    label: "Net Sales Reports",
    reports: [
      { id: "taproom-model",    label: "Taproom"          },
      { id: "contract-brewing", label: "Contract Brewing" },
      { id: "distribution",     label: "Distribution"     },
    ],
  },
  {
    id: "sales",
    label: "Sales Reports",
    reports: [
      { id: "cocktail-sales", label: "Cocktail Sales"  },
      { id: "keg-sales",      label: "Keg Sales"       },
      { id: "gift-cards",     label: "Gift Card Sales" },
    ],
  },
  {
    id: "production",
    label: "Production",
    reports: [{ id: "bbl-tracker", label: "BBL Tracker" }],
  },
] as const;

type GroupId  = (typeof REPORT_GROUPS)[number]["id"];
type ReportId = (typeof REPORT_GROUPS)[number]["reports"][number]["id"];

function getGroup(reportId: ReportId): GroupId {
  for (const g of REPORT_GROUPS) {
    if (g.reports.some((r) => r.id === reportId)) return g.id;
  }
  return REPORT_GROUPS[0].id;
}
function getLabel(reportId: ReportId): string {
  for (const g of REPORT_GROUPS) {
    const r = g.reports.find((r) => r.id === reportId);
    if (r) return r.label;
  }
  return reportId;
}

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function today() { return new Date().toISOString().slice(0, 10); }

const selectCls =
  "bg-zinc-800 border border-zinc-600 rounded-md px-2 py-1.5 sm:px-3 sm:py-2 text-xs sm:text-sm text-zinc-100 " +
  "focus:outline-none focus:ring-2 focus:ring-blue-500";

export default function ReportsPage() {
  const router = useRouter();
  const { role, loading } = useUserRole();
  const [activeGroup,  setActiveGroup]  = useState<GroupId>("net-sales");
  const [activeReport, setActiveReport] = useState<ReportId>("taproom-model");
  const [start, setStart] = useState(firstOfMonth());
  const [end,   setEnd]   = useState(today());

  if (!loading && role !== "admin") { router.replace("/taproom/performance"); return null; }

  function handleGroupChange(gid: GroupId) {
    setActiveGroup(gid);
    setActiveReport(REPORT_GROUPS.find((g) => g.id === gid)!.reports[0].id);
  }
  function handleReportChange(rid: ReportId) {
    setActiveReport(rid);
    setActiveGroup(getGroup(rid));
  }

  const activeGroupReports = REPORT_GROUPS.find((g) => g.id === activeGroup)!.reports;
  const dateProps = { start, end, onStartChange: setStart, onEndChange: setEnd };

  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={TAPROOM_NAV} mobile />

      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Reports</h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            Net sales, cocktail, keg, gift card, production, and inventory reports
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row flex-wrap gap-2 sm:gap-3 sm:items-center mb-6">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
          <label className="text-sm font-medium text-zinc-300">Category</label>
          <select value={activeGroup} onChange={(e) => handleGroupChange(e.target.value as GroupId)} className={selectCls}>
            {REPORT_GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
          <label className="text-sm font-medium text-zinc-300">Report</label>
          <select value={activeReport} onChange={(e) => handleReportChange(e.target.value as ReportId)} className={selectCls}>
            {activeGroupReports.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </div>
      </div>

      <h3 className="text-sm font-medium text-zinc-400 mb-5">{getLabel(activeReport)}</h3>

      {activeReport === "taproom-model"    && <TaproomModelReport    {...dateProps} />}
      {activeReport === "contract-brewing" && <ContractBrewingReport {...dateProps} />}
      {activeReport === "distribution"     && <DistributionReport    {...dateProps} />}
      {activeReport === "cocktail-sales"   && <CocktailSalesReport   {...dateProps} />}
      {activeReport === "keg-sales"        && <KegSalesReport        {...dateProps} />}
      {activeReport === "gift-cards"       && <GiftCardReport        {...dateProps} />}
      {activeReport === "bbl-tracker"      && <BBLTrackerReport      {...dateProps} />}
    </main>
  );
}
