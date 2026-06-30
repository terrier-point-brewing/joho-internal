"use client";

import { useState, useMemo } from "react";
import { formatCurrency } from "@/lib/format";
import ReportControls from "./ReportControls";
import { useSort, SortTh } from "./SortControls";

type RawRow = {
  date: string; time: string; item: string; is_combo: boolean;
  qty: number; gross_sales: string; discounts: string; net_sales: string; tax: string;
};
type GroupedRow = {
  item: string; qty: number;
  gross_sales: string; discounts: string; net_sales: string; tax: string;
};

const GROUP_OPTIONS = [
  { value: "date", label: "Date" },
  { value: "item", label: "Item" },
];

function currency(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return formatCurrency(n);
}

function groupRows(rows: RawRow[]): GroupedRow[] {
  const map = new Map<string, GroupedRow>();
  for (const r of rows) {
    const cur = map.get(r.item);
    if (cur) {
      cur.qty         += r.qty;
      cur.gross_sales  = (parseFloat(cur.gross_sales) + parseFloat(r.gross_sales)).toFixed(2);
      cur.discounts    = (parseFloat(cur.discounts)   + parseFloat(r.discounts)).toFixed(2);
      cur.net_sales    = (parseFloat(cur.net_sales)   + parseFloat(r.net_sales)).toFixed(2);
      cur.tax          = (parseFloat(cur.tax)         + parseFloat(r.tax)).toFixed(2);
    } else {
      map.set(r.item, { item: r.item, qty: r.qty, gross_sales: r.gross_sales, discounts: r.discounts, net_sales: r.net_sales, tax: r.tax });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.item.localeCompare(b.item));
}

function exportCSV(rows: RawRow[], groupBy: string) {
  let csv: string;
  if (groupBy === "item") {
    const gr = groupRows(rows);
    csv = "Item,Qty,Gross Sales,Discounts,Net Sales,Tax\n" +
      gr.map(r => `"${r.item}",${r.qty},${r.gross_sales},${r.discounts},${r.net_sales},${r.tax}`).join("\n");
  } else {
    csv = "Date,Time,Item,Type,Qty,Gross Sales,Discounts,Net Sales,Tax\n" +
      rows.map(r => `${r.date},${r.time},"${r.item}",${r.is_combo ? "Combo" : "Single"},${r.qty},${r.gross_sales},${r.discounts},${r.net_sales},${r.tax}`).join("\n");
  }
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "cocktail-sales.csv"; a.click();
  URL.revokeObjectURL(url);
}

const tdCls = "px-4 py-2";

interface Props { start: string; end: string; onStartChange: (v: string) => void; onEndChange: (v: string) => void; }

export default function CocktailSalesReport({ start, end, onStartChange, onEndChange }: Props) {
  const [rows, setRows]   = useState<RawRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState("date");

  const groupedRows = useMemo(() => (rows ? groupRows(rows) : null), [rows]);

  // Separate sort state per view so switching views doesn't bleed sort
  const rawSort     = useSort(rows);
  const groupedSort = useSort(groupedRows);

  async function runReport() {
    setLoading(true); setError(null); setRows(null);
    try {
      const res = await fetch(`/api/cocktail-sales?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setRows(data.rows);
    } catch (e) { setError(e instanceof Error ? e.message : "Unknown error"); }
    finally { setLoading(false); }
  }

  const totals = rows ? {
    qty:   rows.reduce((s, r) => s + r.qty, 0),
    gross: rows.reduce((s, r) => s + parseFloat(r.gross_sales), 0),
    disc:  rows.reduce((s, r) => s + parseFloat(r.discounts), 0),
    net:   rows.reduce((s, r) => s + parseFloat(r.net_sales), 0),
    tax:   rows.reduce((s, r) => s + parseFloat(r.tax), 0),
  } : null;

  const isGrouped = groupBy === "item";
  const displayRows = isGrouped ? (groupedSort.sorted ?? groupedRows) : (rawSort.sorted ?? rows);
  const sp = isGrouped
    ? { sortKey: groupedSort.sortKey, sortDir: groupedSort.sortDir, onSort: groupedSort.handleSort }
    : { sortKey: rawSort.sortKey,     sortDir: rawSort.sortDir,     onSort: rawSort.handleSort };

  return (
    <div>
      <ReportControls
        start={start} end={end} onStartChange={onStartChange} onEndChange={onEndChange}
        onRun={runReport} loading={loading} hasData={!!rows?.length}
        onExport={() => rows && exportCSV(rows, groupBy)}
        groupBy={groupBy} groupOptions={GROUP_OPTIONS} onGroupByChange={setGroupBy}
      />

      {error && (
        <div className="mt-4 p-3 bg-red-950 border border-red-700 rounded-md text-sm text-red-300">{error}</div>
      )}

      {displayRows !== null && (
        <div className="mt-4">
          <p className="text-sm text-zinc-400 mb-3">
            {displayRows.length === 0
              ? "No cocktail sales found for this period."
              : `${displayRows.length} row${displayRows.length !== 1 ? "s" : ""}`}
          </p>
          {displayRows.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-zinc-700">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-700 bg-zinc-800">
                    {!isGrouped && (
                      <>
                        <SortTh label="Date" col="date" {...sp} />
                        <SortTh label="Time" col="time" {...sp} />
                      </>
                    )}
                    <SortTh label="Item"        col="item"        {...sp} />
                    {!isGrouped && <SortTh label="Type" col="is_combo" {...sp} />}
                    <SortTh label="Qty"         col="qty"         {...sp} align="right" />
                    <SortTh label="Gross Sales" col="gross_sales" {...sp} align="right" />
                    <SortTh label="Discounts"   col="discounts"   {...sp} align="right" />
                    <SortTh label="Net Sales"   col="net_sales"   {...sp} align="right" />
                    <SortTh label="Tax"         col="tax"         {...sp} align="right" />
                  </tr>
                </thead>
                <tbody className="bg-zinc-900">
                  {displayRows.map((row, i) => (
                    <tr key={i} className="border-b border-zinc-800 hover:bg-zinc-800">
                      {!isGrouped && "date" in row && (
                        <>
                          <td className={`${tdCls} text-zinc-200 whitespace-nowrap`}>{(row as RawRow).date}</td>
                          <td className={`${tdCls} text-zinc-400 whitespace-nowrap`}>{(row as RawRow).time}</td>
                        </>
                      )}
                      <td className={`${tdCls} font-medium text-zinc-100`}>{row.item}</td>
                      {!isGrouped && "is_combo" in row && (
                        <td className={tdCls}>
                          {(row as RawRow).is_combo
                            ? <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-900 text-purple-200">Combo</span>
                            : <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-900 text-blue-200">Single</span>}
                        </td>
                      )}
                      <td className={`${tdCls} text-right text-zinc-200`}>{row.qty}</td>
                      <td className={`${tdCls} text-right text-zinc-200`}>{currency(row.gross_sales)}</td>
                      <td className={`${tdCls} text-right text-zinc-400`}>{currency(row.discounts)}</td>
                      <td className={`${tdCls} text-right font-medium text-zinc-100`}>{currency(row.net_sales)}</td>
                      <td className={`${tdCls} text-right text-zinc-400`}>{currency(row.tax)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-zinc-600 bg-zinc-800 font-semibold">
                    {!isGrouped && <td className={tdCls} colSpan={3} />}
                    <td className={`${tdCls} text-zinc-200`}>Totals</td>
                    <td className={`${tdCls} text-right text-zinc-200`}>{totals!.qty}</td>
                    <td className={`${tdCls} text-right text-zinc-200`}>{currency(totals!.gross)}</td>
                    <td className={`${tdCls} text-right text-zinc-400`}>{currency(totals!.disc)}</td>
                    <td className={`${tdCls} text-right text-zinc-100`}>{currency(totals!.net)}</td>
                    <td className={`${tdCls} text-right text-zinc-400`}>{currency(totals!.tax)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
