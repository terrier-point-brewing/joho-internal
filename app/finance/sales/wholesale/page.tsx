"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys, SALES_REPORT_STALE_TIME } from "@/lib/query-keys";
import SalesPageShell from "../SalesPageShell";
import { type SalesRow } from "../SalesTable";
import { type UnrecognizedSummary, type ExciseCoverage } from "../UnrecognizedBanner";
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
  { type: "data",     key: "rev_half_keg",    label: "1/2 Kegs", indent: true },
  { type: "data",     key: "rev_quarter_keg", label: "1/4 Kegs", indent: true },
  { type: "data",     key: "rev_sixth_keg",   label: "1/6 Kegs", indent: true },
  { type: "data",     key: "rev_cans",        label: "Cans",      indent: true },
  { type: "subtotal", key: "gross_revenue",   label: "Gross Revenue" },
  { type: "spacer" },

  // ── Deductions ────────────────────────────────────────────────────────────
  { type: "section", label: "Deductions" },
  { type: "data",     key: "discounts",        label: "Discounts", indent: true },
  { type: "data",     key: "remits",           label: "Remits",    indent: true },
  { type: "subtotal", key: "total_deductions", label: "Deductions" },
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
  distribution:    Record<string, Record<string, number>>;
  contractBrewing: Record<string, Record<string, number>>;
  wholesale:       Record<string, Record<string, number>>;
  unrecognized:    UnrecognizedSummary;
  exciseCoverage:  ExciseCoverage;
}

export default function WholesaleSalesPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.finance.salesInvoices(year),
    queryFn:  () => fetchJson<InvoiceSalesData>(`/api/finance/sales/invoices?year=${year}`),
    staleTime: SALES_REPORT_STALE_TIME,
  });

  const months  = data?.months    ?? [];
  const monthly = data?.wholesale ?? {};
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
      unrecognized={data?.unrecognized}
    />
  );
}
