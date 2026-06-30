"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys, SALES_REPORT_STALE_TIME } from "@/lib/query-keys";
import SalesPageShell from "../SalesPageShell";
import { type SalesRow } from "../SalesTable";
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
    staleTime: SALES_REPORT_STALE_TIME,
  });

  const months  = data?.months  ?? [];
  const monthly = data?.monthly ?? {};
  const years   = Array.from({ length: 3 }, (_, i) => currentYear - i);

  return (
    <SalesPageShell
      rows={ROWS}
      months={months}
      monthly={monthly}
      loading={isFetching}
      error={error}
      year={year}
      years={years}
      onYearChange={setYear}
      onRefresh={() => refetch()}
    />
  );
}
