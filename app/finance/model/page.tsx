"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import SalesTable, { type SalesRow } from "../sales/SalesTable";
import { fetchJson } from "@/app/production/hooks/queries";

const ROWS: SalesRow[] = [
  // ── Gross Revenue ─────────────────────────────────────────────────────────
  { type: "section",  label: "Gross Revenue" },
  { type: "data",     key: "cb_gross",       label: "Contract Brewing", indent: true },
  { type: "data",     key: "dist_gross",     label: "Distribution",     indent: true },
  { type: "data",     key: "tap_gross",      label: "Taproom",          indent: true },
  { type: "subtotal", key: "gross_revenue",  label: "Gross Revenue" },
  { type: "spacer" },

  // ── Deductions ────────────────────────────────────────────────────────────
  { type: "section",  label: "Deductions" },
  { type: "data",     key: "cb_deductions",    label: "Contract Brewing", indent: true },
  { type: "data",     key: "dist_deductions",  label: "Distribution",     indent: true },
  { type: "data",     key: "tap_deductions",   label: "Taproom",          indent: true },
  { type: "subtotal", key: "total_deductions", label: "Deductions" },
  { type: "spacer" },

  // ── Net Sales ─────────────────────────────────────────────────────────────
  { type: "subtotal", key: "net_sales", label: "Net Sales" },
  { type: "spacer" },

  // ── Additional Stats ──────────────────────────────────────────────────────
  { type: "section", label: "Additional Stats" },
  { type: "data", key: "tips",       label: "Tips Collected",       indent: true },
  { type: "data", key: "sales_tax",  label: "Sales Tax Collected",  indent: true },
  { type: "data", key: "excise_tax", label: "Excise Tax Collected", indent: true },
];

interface TaproomSalesData {
  months: string[];
  monthly: Record<string, Record<string, number>>;
}

interface InvoiceSalesData {
  months: string[];
  contractBrewing: Record<string, Record<string, number>>;
  distribution:    Record<string, Record<string, number>>;
}

export default function ModelPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const years = Array.from({ length: 3 }, (_, i) => currentYear - i);

  const {
    data: taproomData, isFetching: taproomFetching, error: taproomError, refetch: refetchTaproom,
  } = useQuery({
    queryKey: queryKeys.finance.salesTaproom(year),
    queryFn:  () => fetchJson<TaproomSalesData>(`/api/finance/sales/taproom?year=${year}`),
  });

  const {
    data: invoiceData, isFetching: invoiceFetching, error: invoiceError, refetch: refetchInvoices,
  } = useQuery({
    queryKey: queryKeys.finance.salesInvoices(year),
    queryFn:  () => fetchJson<InvoiceSalesData>(`/api/finance/sales/invoices?year=${year}`),
  });

  const isFetching = taproomFetching || invoiceFetching;
  const error = taproomError ?? invoiceError;

  function handleRefresh() {
    void refetchTaproom();
    void refetchInvoices();
  }

  // Both APIs return the same month list for a given year; prefer taproom
  const months = taproomData?.months ?? invoiceData?.months ?? [];

  const monthly = useMemo(() => {
    const result: Record<string, Record<string, number>> = {};
    for (const ym of months) {
      const tap  = taproomData?.monthly[ym]         ?? {};
      const cb   = invoiceData?.contractBrewing[ym] ?? {};
      const dist = invoiceData?.distribution[ym]    ?? {};

      const cbGross   = cb.gross_revenue   ?? 0;
      const distGross = dist.gross_revenue ?? 0;
      const tapGross  = tap.gross_revenue  ?? 0;
      const grossRev  = cbGross + distGross + tapGross;

      const cbDeduct    = cb.total_deductions   ?? 0;
      const distDeduct  = dist.total_deductions ?? 0;
      const tapDeduct   = (tap.total_discounts  ?? 0) + (tap.total_returns ?? 0);
      const totalDeduct = cbDeduct + distDeduct + tapDeduct;

      const exciseTax =
        (cb.excise_tax_nc   ?? 0) + (cb.excise_tax_federal   ?? 0) +
        (dist.excise_tax_nc ?? 0) + (dist.excise_tax_federal ?? 0);

      result[ym] = {
        cb_gross:         cbGross,
        dist_gross:       distGross,
        tap_gross:        tapGross,
        gross_revenue:    grossRev,
        cb_deductions:    cbDeduct,
        dist_deductions:  distDeduct,
        tap_deductions:   tapDeduct,
        total_deductions: totalDeduct,
        net_sales:        grossRev - totalDeduct,
        tips:             tap.tips ?? 0,
        sales_tax:        tap.tax  ?? 0,
        excise_tax:       exciseTax,
      };
    }
    return result;
  }, [months, taproomData, invoiceData]);

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <div className="shrink-0 px-6 pt-5 pb-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-base font-semibold text-zinc-100">Finance</h1>
            <p className="text-xs text-zinc-500 mt-0.5">Admin only</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
            >
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button
              onClick={handleRefresh}
              className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-white text-xs rounded transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
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
