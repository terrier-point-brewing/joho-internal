"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

// Reports
import CocktailSalesReport   from "../reports/components/CocktailSalesReport";
import KegSalesReport        from "../reports/components/KegSalesReport";
import TaproomModelReport    from "../reports/components/TaproomModelReport";
import GiftCardReport        from "../reports/components/GiftCardReport";
import ContractBrewingReport from "../reports/components/ContractBrewingReport";
import DistributionReport    from "../reports/components/DistributionReport";
import BBLTrackerReport      from "../reports/components/BBLTrackerReport";
import ShrinkageReport       from "../reports/components/ShrinkageReport";

// Targets
import AchievementTab   from "./components/AchievementTab";
import TargetSettingTab from "./components/TargetSettingTab";
import ManualEntriesTab from "./components/ManualEntriesTab";

// Performance
import SalesPulseTab from "./components/SalesPulseTab";

// ---------------------------------------------------------------------------
// Report catalogue
// ---------------------------------------------------------------------------

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
  {
    id: "inventory",
    label: "Inventory Management",
    reports: [{ id: "shrinkage", label: "Shrinkage" }],
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

// ---------------------------------------------------------------------------
// Targets subtabs
// ---------------------------------------------------------------------------

const TARGETS_SUBTABS = [
  { key: "achievement",    label: "Achievement"    },
  { key: "target-setting", label: "Target Setting" },
  { key: "manual-entries", label: "Manual Entries" },
] as const;

type TargetsSubtab = typeof TARGETS_SUBTABS[number]["key"];

const PERFORMANCE_SUBTABS = [
  { key: "sales-pulse", label: "Sales Pulse" },
] as const;

type PerformanceSubtab = typeof PERFORMANCE_SUBTABS[number]["key"];

// ---------------------------------------------------------------------------
// Shared style helpers
// ---------------------------------------------------------------------------

const selectCls =
  "bg-zinc-800 border border-zinc-600 rounded-md px-2 py-1.5 sm:px-3 sm:py-2 text-xs sm:text-sm text-zinc-100 " +
  "focus:outline-none focus:ring-2 focus:ring-blue-500";

const TOP_TABS = [
  { key: "targets",     label: "Targets"     },
  { key: "performance", label: "Performance" },
  { key: "reports",     label: "Reports"     },
] as const;

// ---------------------------------------------------------------------------
// Page content (needs Suspense for useSearchParams)
// ---------------------------------------------------------------------------

function TaproomContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = searchParams.get("tab") ?? "performance";

  // Targets subtab uses local state (mirrors Production's brewingSubtab pattern)
  const [targetsSubtab,     setTargetsSubtab]     = useState<TargetsSubtab>("achievement");
  const [performanceSubtab, setPerformanceSubtab] = useState<PerformanceSubtab>("sales-pulse");

  // Reports state
  const [activeGroup,  setActiveGroup]  = useState<GroupId>("net-sales");
  const [activeReport, setActiveReport] = useState<ReportId>("taproom-model");
  const [start, setStart] = useState(firstOfMonth());
  const [end,   setEnd]   = useState(today());

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

      {/* Mobile top-level tab nav (hidden on md+ where sidebar handles this) */}
      <div className="md:hidden flex border-b border-zinc-800 mb-4 -mx-4 px-4">
        {TOP_TABS.map(({ key, label }) => (
          <Link
            key={key}
            href={`/taproom?tab=${key}`}
            className={`flex-1 text-center py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === key
                ? "text-amber-400 border-amber-500"
                : "text-zinc-500 border-transparent hover:text-zinc-300"
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Reports tab                                                         */}
      {/* ------------------------------------------------------------------ */}
      {tab === "reports" && (
        <>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-medium text-zinc-100">Reports</h2>
              <p className="text-sm text-zinc-500 mt-0.5">
                Net sales, cocktail, keg, gift card, production, and inventory reports
              </p>
            </div>
          </div>

          {/* Report selectors */}
          <div className="flex flex-col sm:flex-row flex-wrap gap-2 sm:gap-3 sm:items-center mb-6">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
              <label className="text-sm font-medium text-zinc-300">Category</label>
              <select
                value={activeGroup}
                onChange={(e) => handleGroupChange(e.target.value as GroupId)}
                className={selectCls}
              >
                {REPORT_GROUPS.map((g) => (
                  <option key={g.id} value={g.id}>{g.label}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
              <label className="text-sm font-medium text-zinc-300">Report</label>
              <select
                value={activeReport}
                onChange={(e) => handleReportChange(e.target.value as ReportId)}
                className={selectCls}
              >
                {activeGroupReports.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
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
          {activeReport === "shrinkage"        && <ShrinkageReport       {...dateProps} />}
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Targets tab                                                         */}
      {/* ------------------------------------------------------------------ */}
      {tab === "targets" && (
        <>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-medium text-zinc-100">Targets</h2>
              <p className="text-sm text-zinc-500 mt-0.5">
                Track achievement vs. quarterly targets; manage targets and manual data
              </p>
            </div>
          </div>

          {/* Targets subtab nav */}
          <div className="flex gap-0.5 mb-4 sm:mb-6 border-b border-zinc-800 pb-0 overflow-x-auto scrollbar-none">
            {TARGETS_SUBTABS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setTargetsSubtab(key)}
                className={`px-3 sm:px-4 py-2 text-xs sm:text-sm font-medium rounded-t transition-colors -mb-px border-b-2 whitespace-nowrap ${
                  targetsSubtab === key
                    ? "text-amber-400 border-amber-500 bg-amber-900/10"
                    : "text-zinc-500 border-transparent hover:text-zinc-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {targetsSubtab === "achievement"    && <AchievementTab />}
          {targetsSubtab === "target-setting" && <TargetSettingTab />}
          {targetsSubtab === "manual-entries" && <ManualEntriesTab />}
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Performance tab                                                      */}
      {/* ------------------------------------------------------------------ */}
      {tab === "performance" && (
        <>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-medium text-zinc-100">Performance</h2>
              <p className="text-sm text-zinc-500 mt-0.5">
                Key taproom metrics and sales trends
              </p>
            </div>
          </div>

          <div className="flex gap-0.5 mb-4 sm:mb-6 border-b border-zinc-800 pb-0 overflow-x-auto scrollbar-none">
            {PERFORMANCE_SUBTABS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setPerformanceSubtab(key)}
                className={`px-3 sm:px-4 py-2 text-xs sm:text-sm font-medium rounded-t transition-colors -mb-px border-b-2 whitespace-nowrap ${
                  performanceSubtab === key
                    ? "text-amber-400 border-amber-500 bg-amber-900/10"
                    : "text-zinc-500 border-transparent hover:text-zinc-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {performanceSubtab === "sales-pulse" && <SalesPulseTab />}
        </>
      )}

    </main>
  );
}

// ---------------------------------------------------------------------------
// Exported page — Suspense wrapper required for useSearchParams
// ---------------------------------------------------------------------------

export default function TaproomManagementPage() {
  return (
    <Suspense>
      <TaproomContent />
    </Suspense>
  );
}
