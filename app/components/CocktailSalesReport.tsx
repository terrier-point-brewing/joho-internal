"use client";

import { useState } from "react";
import ReportControls from "./ReportControls";

type RawRow = {
  date: string; time: string; item: string; is_combo: boolean;
  qty: number; gross_sales: string; discounts: string; net_sales: string; tax: string;
};
type GroupedRow = { item: string; qty: number; gross_sales: string; discounts: string; net_sales: string; tax: string };

const GROUP_OPTIONS = [
  { value: "date", label: "Date" },
  { value: "item", label: "Item" },
];

function currency(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function today() { return new Date().toISOString().slice(0, 10); }
function firstOfMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; }

function groupRows(rows: RawRow[]): GroupedRow[] {
  const map = new Map<string, GroupedRow>();
  for (const r of rows) {
    const cur = map.get(r.item);
    if (cur) {
      cur.qty += r.qty;
      cur.gross_sales = (parseFloat(cur.gross_sales) + parseFloat(r.gross_sales)).toFixed(2);
      cur.discounts   = (parseFloat(cur.discounts)   + parseFloat(r.discounts)).toFixed(2);
      cur.net_sales   = (parseFloat(cur.net_sales)   + parseFloat(r.net_sales)).toFixed(2);
      cur.tax         = (parseFloat(cur.tax)         + parseFloat(r.tax)).toFixed(2);
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
      rows.map(r => `${r.date},${r.time},"${r.item}",${r.is_combo?"Combo":"Single"},${r.qty},${r.gross_sales},${r.discounts},${r.net_sales},${r.tax}`).join("\n");
  }
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "cocktail-sales.csv"; a.click();
  URL.revokeObjectURL(url);
}

export default function CocktailSalesReport() {
  const [start, setStart] = useState(firstOfMonth());
  const [end, setEnd]     = useState(today());
  const [rows, setRows]   = useState<RawRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState("date");

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

  const displayRows = rows ? (groupBy === "item" ? groupRows(rows) : rows) : null;
  const totals = rows ? {
    qty:   rows.reduce((s, r) => s + r.qty, 0),
    gross: rows.reduce((s, r) => s + parseFloat(r.gross_sales), 0),
    disc:  rows.reduce((s, r) => s + parseFloat(r.discounts), 0),
    net:   rows.reduce((s, r) => s + parseFloat(r.net_sales), 0),
    tax:   rows.reduce((s, r) => s + parseFloat(r.tax), 0),
  } : null;

  return (
    <div>
      <ReportControls
        start={start} end={end} onStartChange={setStart} onEndChange={setEnd}
        onRun={runReport} loading={loading} hasData={!!rows?.length}
        onExport={() => rows && exportCSV(rows, groupBy)}
        groupBy={groupBy} groupOptions={GROUP_OPTIONS} onGroupByChange={setGroupBy}
      />

      {error && <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>}

      {displayRows !== null && (
        <div className="mt-4">
          <p className="text-sm text-gray-600 mb-3">
            {displayRows.length === 0 ? "No cocktail sales found for this period." : `${displayRows.length} row${displayRows.length !== 1 ? "s" : ""}`}
          </p>
          {displayRows.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    {groupBy === "date" && <><th className="px-4 py-3 text-left font-medium text-gray-700">Date</th><th className="px-4 py-3 text-left font-medium text-gray-700">Time</th></>}
                    <th className="px-4 py-3 text-left font-medium text-gray-700">Item</th>
                    {groupBy === "date" && <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>}
                    <th className="px-4 py-3 text-right font-medium text-gray-700">Qty</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-700">Gross Sales</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-700">Discounts</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-700">Net Sales</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-700">Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row, i) => (
                    <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                      {groupBy === "date" && "date" in row && (
                        <><td className="px-4 py-2 text-gray-700 whitespace-nowrap">{(row as RawRow).date}</td>
                        <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{(row as RawRow).time}</td></>
                      )}
                      <td className="px-4 py-2 font-medium text-gray-900">{row.item}</td>
                      {groupBy === "date" && "is_combo" in row && (
                        <td className="px-4 py-2">
                          {(row as RawRow).is_combo
                            ? <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800">Combo</span>
                            : <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">Single</span>}
                        </td>
                      )}
                      <td className="px-4 py-2 text-right text-gray-700">{row.qty}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{currency(row.gross_sales)}</td>
                      <td className="px-4 py-2 text-right text-gray-500">{currency(row.discounts)}</td>
                      <td className="px-4 py-2 text-right font-medium text-gray-900">{currency(row.net_sales)}</td>
                      <td className="px-4 py-2 text-right text-gray-500">{currency(row.tax)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                    {groupBy === "date" && <td className="px-4 py-3" colSpan={3} />}
                    <td className="px-4 py-3 text-gray-700">Totals</td>
                    <td className="px-4 py-3 text-right text-gray-700">{totals!.qty}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{currency(totals!.gross)}</td>
                    <td className="px-4 py-3 text-right text-gray-500">{currency(totals!.disc)}</td>
                    <td className="px-4 py-3 text-right text-gray-900">{currency(totals!.net)}</td>
                    <td className="px-4 py-3 text-right text-gray-500">{currency(totals!.tax)}</td>
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
