"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import SalesNav from "../SalesNav";
import SalesTable, { type SalesRow } from "../SalesTable";
import { fetchJson } from "@/app/production/hooks/queries";

const ROWS: SalesRow[] = [
  // ── Volume ────────────────────────────────────────────────────────────────
  { type: "section", label: "Volume" },
  { type: "data",     key: "vol_draft_bbl",   label: "Draft",      format: "bbl", indent: true },
  { type: "data",     key: "vol_half_keg",    label: "1/2 Kegs",  format: "qty", indent: true },
  { type: "data",     key: "vol_quarter_keg", label: "1/4 Kegs",  format: "qty", indent: true },
  { type: "data",     key: "vol_sixth_keg",   label: "1/6 Kegs",  format: "qty", indent: true },
  { type: "data",     key: "vol_cans",        label: "Cans",       format: "qty", indent: true },
  { type: "subtotal", key: "total_bbl",       label: "Total BBLs", format: "bbl" },
  { type: "spacer" },

  // ── Gross Revenue ─────────────────────────────────────────────────────────
  { type: "section", label: "Gross Revenue" },
  { type: "data",     key: "gross_DRAFT_BEER",         label: "Draft",               indent: true },
  { type: "data",     key: "gross_LIQUOR",             label: "Liquor",              indent: true },
  { type: "data",     key: "gross_WINE_CIDER_SELTZER", label: "Wine/Cider/Seltzers", indent: true },
  { type: "data",     key: "gross_COCKTAILS",          label: "Cocktails",           indent: true },
  { type: "data",     key: "gross_NA_SNACKS",          label: "NA/Snacks",           indent: true },
  { type: "data",     key: "gross_KEGS",               label: "Kegs",                indent: true },
  { type: "data",     key: "gross_CANS",               label: "Cans",                indent: true },
  { type: "data",     key: "gross_MERCHANDISE",        label: "Merch",               indent: true },
  { type: "data",     key: "gross_CO2",                label: "CO2",                 indent: true },
  { type: "data",     key: "gross_OTHER",              label: "Other",               indent: true },
  { type: "data",     key: "manual_adjustments",       label: "Manual Adjustments",  indent: true },
  { type: "subtotal", key: "gross_revenue",            label: "Gross Revenue" },
  { type: "spacer" },

  // ── Discounts ─────────────────────────────────────────────────────────────
  { type: "section", label: "Discounts" },
  { type: "data",     key: "discounts_DRAFT_BEER",         label: "Draft",               indent: true },
  { type: "data",     key: "discounts_LIQUOR",             label: "Liquor",              indent: true },
  { type: "data",     key: "discounts_WINE_CIDER_SELTZER", label: "Wine/Cider/Seltzers", indent: true },
  { type: "data",     key: "discounts_COCKTAILS",          label: "Cocktails",           indent: true },
  { type: "data",     key: "discounts_NA_SNACKS",          label: "NA/Snacks",           indent: true },
  { type: "data",     key: "discounts_KEGS",               label: "Kegs",                indent: true },
  { type: "data",     key: "discounts_CANS",               label: "Cans",                indent: true },
  { type: "data",     key: "discounts_MERCHANDISE",        label: "Merch",               indent: true },
  { type: "data",     key: "discounts_CO2",                label: "CO2",                 indent: true },
  { type: "data",     key: "discounts_OTHER",              label: "Other",               indent: true },
  { type: "subtotal", key: "total_discounts",              label: "Discounts" },
  { type: "spacer" },

  // ── Returns ───────────────────────────────────────────────────────────────
  { type: "section", label: "Returns" },
  { type: "data",     key: "returns_DRAFT_BEER",         label: "Draft",               indent: true },
  { type: "data",     key: "returns_LIQUOR",             label: "Liquor",              indent: true },
  { type: "data",     key: "returns_WINE_CIDER_SELTZER", label: "Wine/Cider/Seltzers", indent: true },
  { type: "data",     key: "returns_COCKTAILS",          label: "Cocktails",           indent: true },
  { type: "data",     key: "returns_NA_SNACKS",          label: "NA/Snacks",           indent: true },
  { type: "data",     key: "returns_KEGS",               label: "Kegs",                indent: true },
  { type: "data",     key: "returns_CANS",               label: "Cans",                indent: true },
  { type: "data",     key: "returns_MERCHANDISE",        label: "Merch",               indent: true },
  { type: "data",     key: "returns_CO2",                label: "CO2",                 indent: true },
  { type: "data",     key: "returns_OTHER",              label: "Other",               indent: true },
  { type: "subtotal", key: "total_returns",              label: "Returns" },
  { type: "spacer" },

  // ── Net Sales ─────────────────────────────────────────────────────────────
  { type: "subtotal", key: "net_sales", label: "Net Sales" },
  { type: "spacer" },

  // ── Additional Stats ──────────────────────────────────────────────────────
  { type: "section", label: "Additional Stats" },
  { type: "data", key: "tips", label: "Tips Collected",       indent: true },
  { type: "data", key: "tax",  label: "Sales Tax Collected",  indent: true },
];

interface TaproomSalesData {
  months: string[];
  monthly: Record<string, Record<string, number>>;
}

export default function TaproomSalesPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.finance.salesTaproom(year),
    queryFn:  () => fetchJson<TaproomSalesData>(`/api/finance/sales/taproom?year=${year}`),
  });

  const months  = data?.months  ?? [];
  const monthly = data?.monthly ?? {};
  const years   = Array.from({ length: 3 }, (_, i) => currentYear - i);

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <div className="shrink-0 px-6 pt-5 pb-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-base font-semibold text-zinc-100">Finance</h1>
            <p className="text-xs text-zinc-500 mt-0.5">Admin only</p>
          </div>
          <div className="flex items-center gap-2">
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={() => refetch()}
              className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-white text-xs rounded transition-colors">
              Refresh
            </button>
          </div>
        </div>
        <SalesNav />
      </div>

      {error && (
        <div className="mx-6 mb-4 bg-red-900/30 border border-red-700 rounded p-3 text-sm text-red-300">
          {error instanceof Error ? error.message : "Failed to load"}
        </div>
      )}

      <div className="flex-1 overflow-auto px-6 pb-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <SalesTable rows={ROWS} months={months} monthly={monthly} loading={isFetching} />
        </div>
      </div>
    </div>
  );
}
