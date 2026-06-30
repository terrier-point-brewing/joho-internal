"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import SalesPageShell from "../SalesPageShell";
import { type SalesRow } from "../SalesTable";
import { fetchJson } from "@/app/production/hooks/queries";

const ROWS: SalesRow[] = [
  // ── Volume ────────────────────────────────────────────────────────────────
  { type: "section",  label: "Volume" },
  { type: "data",     key: "vol_draft_bbl", label: "Draft", format: "bbl", indent: true },
  { type: "subtotal", key: "vol_draft_bbl", label: "Total BBLs", format: "bbl" },
  { type: "spacer" },

  // ── Gross Revenue ─────────────────────────────────────────────────────────
  { type: "section",  label: "Gross Revenue" },
  { type: "data",     key: "gross_DRAFT",   label: "Draft", indent: true },
  { type: "subtotal", key: "gross_revenue", label: "Gross Revenue" },
  { type: "spacer" },

  // ── Discounts ─────────────────────────────────────────────────────────────
  { type: "section",  label: "Discounts" },
  { type: "data",     key: "discounts_DRAFT",   label: "Draft", indent: true },
  { type: "subtotal", key: "total_discounts",   label: "Discounts" },
  { type: "spacer" },

  // ── Returns ───────────────────────────────────────────────────────────────
  { type: "section",  label: "Returns" },
  { type: "data",     key: "returns_DRAFT", label: "Draft", indent: true },
  { type: "subtotal", key: "total_returns", label: "Returns" },
  { type: "spacer" },

  // ── Net Sales ─────────────────────────────────────────────────────────────
  { type: "subtotal", key: "net_sales", label: "Net Sales" },
  { type: "spacer" },

  // ── Additional Stats ──────────────────────────────────────────────────────
  { type: "section", label: "Additional Stats" },
  { type: "data",    key: "tips", label: "Tips Collected",      indent: true },
  { type: "data",    key: "tax",  label: "Sales Tax Collected", indent: true },
];

interface EventsSalesData {
  months: string[];
  monthly: Record<string, Record<string, number>>;
}

export default function EventsSalesPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.finance.salesEvents(year),
    queryFn:  () => fetchJson<EventsSalesData>(`/api/finance/sales/events?year=${year}`),
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
