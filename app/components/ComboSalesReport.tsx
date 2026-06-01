"use client";

import { useState } from "react";
import ReportControls from "./ReportControls";

type RawRow = {
  date: string;
  time: string;
  item: string;
  qty: number;
  gross_sales: string;
  discounts: string;
  net_sales: string;
  tax: string;
};

type GroupedRow = {
  item: string;
  qty: number;
  gross_sales: string;
  discounts: string;
  net_sales: string;
  tax: string;
};

function currency(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function groupByItem(rows: RawRow[]): GroupedRow[] {
  const map = new Map<string, GroupedRow>();
  for (const r of rows) {
    const existing = map.get(r.item);
    if (existing) {
      existing.qty += r.qty;
      existing.gross_sales = (parseFloat(existing.gross_sales) + parseFloat(r.gross_sales)).toFixed(2);
      existing.discounts = (parseFloat(existing.discounts) + parseFloat(r.discounts)).toFixed(2);
      existing.net_sales = (parseFloat(existing.net_sales) + parseFloat(r.net_sales)).toFixed(2);
      existing.tax = (parseFloat(existing.tax) + parseFloat(r.tax)).toFixed(2);
    } else {
      map.set(r.item, { item: r.item, qty: r.qty, gross_sales: r.gross_sales, discounts: r.discounts, net_sales: r.net_sales, tax: r.tax });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.item.localeCompare(b.item));
}

function exportCSV(rows: RawRow[], grouped: boolean) {
  let csv: string;
  if (grouped) {
    const gr = groupByItem(rows);
    csv = "Item,Qty,Gross Sales,Discounts,Net Sales,Tax\n" +
      gr.map(r => `${r.item},${r.qty},${r.gross_sales},${r.discounts},${r.net_sales},${r.tax}`).join("\n");
  } else {
    csv = "Date,Time,Item,Qty,Gross Sales,Discounts,Net Sales,Tax\n" +
      rows.map(r => `${r.date},${r.time},${r.item},${r.qty},${r.gross_sales},${r.discounts},${r.net_sales},${r.tax}`).join("\n");
  }
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "combo-sales.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export default function ComboSalesReport() {
  const [start, setStart] = useState(firstOfMonth());
  const [end, setEnd] = useState(today());
  const [rows, setRows] = useState<RawRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grouped, setGrouped] = useState(false);

  async function runReport() {
    setLoading(true); setError(null); setRows(null);
    try {
      const res = await fetch(`/api/combo-sales?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setRows(data.rows);
    } catch (e) { setError(e instanceof Error ? e.message : "Unknown error"); }
    finally { setLoading(false); }
  }

  const displayRows = rows ? (grouped ? groupByItem(rows) : rows) : null;

  // Totals (always from raw rows so grouped/ungrouped match)
  const totals = rows ? {
    qty: rows.reduce((s, r) => s + r.qty, 0),
    gross: rows.reduce((s, r) => s + parseFloat(r.gross_sales), 0),
    disc: rows.reduce((s, r) => s + parseFloat(r.discounts), 0),
    net: rows.reduce((s, r) => s + parseFloat(r.net_sales), 0),
    tax: rows.reduce((s, r) => s + parseFloat(r.tax), 0),
  } : null;

  return (
    <div>
      <ReportControls
        start={start} end={end}
        onStartChange={setStart} onEndChange={setEnd}
        onRun={runReport} loading={loading}
        hasData={!!rows?.length}
        onExport={() => rows && exportCSV(rows, grouped)}
        groupByItem={grouped} onGroupByItemChange={setGrouped}
      />

      {error && <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>}

      {displayRows !== null && (
        <div className="mt-4">
          <p className="text-sm text-gray-600 mb-3">
            {displayRows.length === 0 ? "No combo sales found for this period." : `${displayRows.length} row${displayRows.length !== 1 ? "s" : ""}`}
          </p>

          {displayRows.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    {!grouped && <><th className="px-4 py-3 text-left font-medium text-gray-700">Date</th><th className="px-4 py-3 text-left font-medium text-gray-700">Time</th></>}
                    <th className="px-4 py-3 text-left font-medium text-gray-700">Item</th>
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
                      {!grouped && "date" in row && (
                        <><td className="px-4 py-2 text-gray-700 whitespace-nowrap">{(row as RawRow).date}</td>
                        <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{(row as RawRow).time}</td></>
                      )}
                      <td className="px-4 py-2 font-medium text-gray-900">{row.item}</td>
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
                    {!grouped && <td className="px-4 py-3" colSpan={2} />}
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
