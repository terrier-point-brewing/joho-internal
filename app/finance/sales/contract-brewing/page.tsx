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
  { type: "data",     key: "vol_half_keg",    label: "1/2 Kegs",  format: "qty", indent: true },
  { type: "data",     key: "vol_quarter_keg", label: "1/4 Kegs",  format: "qty", indent: true },
  { type: "data",     key: "vol_sixth_keg",   label: "1/6 Kegs",  format: "qty", indent: true },
  { type: "data",     key: "vol_cans",        label: "Cans",       format: "qty", indent: true },
  { type: "subtotal", key: "total_bbl",       label: "Total BBLs", format: "bbl" },
  { type: "spacer" },

  // ── Gross Revenue ─────────────────────────────────────────────────────────
  { type: "section", label: "Gross Revenue" },
  { type: "data",     key: "materials_packaging", label: "Materials & Packaging", indent: true },
  { type: "data",     key: "packaging_fees",      label: "Packaging Fees",        indent: true },
  { type: "data",     key: "other_services",      label: "Other Services",         indent: true },
  { type: "data",     key: "pass_through_taxes",  label: "Pass-Through Taxes",    indent: true },
  { type: "subtotal", key: "gross_revenue",       label: "Gross Revenue" },
  { type: "spacer" },

  // ── Deductions ────────────────────────────────────────────────────────────
  { type: "section", label: "Deductions" },
  { type: "data",     key: "discounts",           label: "Discounts",          indent: true },
  { type: "data",     key: "remits",              label: "Remits",             indent: true },
  { type: "data",     key: "deduct_pass_through", label: "Pass-Through Taxes", indent: true },
  { type: "subtotal", key: "total_deductions",    label: "Deductions" },
  { type: "spacer" },

  // ── Net Sales ─────────────────────────────────────────────────────────────
  { type: "subtotal", key: "net_sales", label: "Net Sales" },
  { type: "spacer" },

  // ── Additional Stats ──────────────────────────────────────────────────────
  { type: "section", label: "Additional Stats" },
  { type: "data", key: "excise_tax_nc",      label: "NC Excise Tax",      indent: true },
  { type: "data", key: "excise_tax_federal", label: "Federal Excise Tax", indent: true },
];

interface InvoiceSalesData {
  months: string[];
  contractBrewing: Record<string, Record<string, number>>;
  distribution:    Record<string, Record<string, number>>;
}

export default function ContractBrewingSalesPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.finance.salesInvoices(year),
    queryFn:  () => fetchJson<InvoiceSalesData>(`/api/finance/sales/invoices?year=${year}`),
  });

  const months  = data?.months          ?? [];
  const monthly = data?.contractBrewing ?? {};
  const years   = Array.from({ length: 3 }, (_, i) => currentYear - i);

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-4">
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
        <div className="mx-4 sm:mx-6 mb-4 bg-red-900/30 border border-red-700 rounded p-3 text-sm text-red-300">
          {error instanceof Error ? error.message : "Failed to load"}
        </div>
      )}

      <div className="flex-1 overflow-auto px-4 sm:px-6 pb-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <SalesTable rows={ROWS} months={months} monthly={monthly} loading={isFetching} />
        </div>
      </div>
    </div>
  );
}
