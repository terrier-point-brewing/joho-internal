"use client";

import { useState } from "react";
import ReportControls from "./ReportControls";

type RawRow = {
  date: string;
  time: string;
  beer: string;
  size: string;
  qty: number;
  is_transfer: boolean;
  discount_names: string[];
  gross_sales: string;
  discounts: string;
  net_sales: string;
  tax: string;
};

type GroupedRow = {
  beer: string;
  size: string;
  sales_qty: number;
  transfer_qty: number;
  gross_sales: string;
  discounts: string;
  net_sales: string;
  tax: string;
};

function currency(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function today() { return new Date().toISOString().slice(0, 10); }
function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// Keg size sort order for consistent display
const KEG_SIZE_ORDER: Record<string, number> = { "1/6 Keg": 0, "1/4 Keg": 1, "1/2 Keg": 2 };

function groupByItem(rows: RawRow[]): GroupedRow[] {
  const map = new Map<string, GroupedRow>();
  for (const r of rows) {
    const key = `${r.beer}||${r.size}`;
    const existing = map.get(key);
    if (existing) {
      if (r.is_transfer) {
        existing.transfer_qty += r.qty;
      } else {
        existing.sales_qty += r.qty;
        existing.gross_sales = (parseFloat(existing.gross_sales) + parseFloat(r.gross_sales)).toFixed(2);
        existing.discounts = (parseFloat(existing.discounts) + parseFloat(r.discounts)).toFixed(2);
        existing.net_sales = (parseFloat(existing.net_sales) + parseFloat(r.net_sales)).toFixed(2);
        existing.tax = (parseFloat(existing.tax) + parseFloat(r.tax)).toFixed(2);
      }
    } else {
      map.set(key, {
        beer: r.beer,
        size: r.size,
        sales_qty: r.is_transfer ? 0 : r.qty,
        transfer_qty: r.is_transfer ? r.qty : 0,
        gross_sales: r.is_transfer ? "0.00" : r.gross_sales,
        discounts: r.is_transfer ? "0.00" : r.discounts,
        net_sales: r.is_transfer ? "0.00" : r.net_sales,
        tax: r.is_transfer ? "0.00" : r.tax,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const nameCompare = a.beer.localeCompare(b.beer);
    if (nameCompare !== 0) return nameCompare;
    return (KEG_SIZE_ORDER[a.size] ?? 99) - (KEG_SIZE_ORDER[b.size] ?? 99);
  });
}

function exportCSV(rows: RawRow[], grouped: boolean) {
  let csv: string;
  if (grouped) {
    const gr = groupByItem(rows);
    csv = "Beer,Size,Sales Qty,Transfers,Gross Sales,Discounts,Net Sales,Tax\n" +
      gr.map(r => `${r.beer},${r.size},${r.sales_qty},${r.transfer_qty},${r.gross_sales},${r.discounts},${r.net_sales},${r.tax}`).join("\n");
  } else {
    csv = "Date,Time,Beer,Size,Qty,Type,Gross Sales,Discounts,Net Sales,Tax\n" +
      rows.map(r => `${r.date},${r.time},${r.beer},${r.size},${r.qty},${r.is_transfer ? "Transfer" : "Sale"},${r.gross_sales},${r.discounts},${r.net_sales},${r.tax}`).join("\n");
  }
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "keg-sales.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export default function KegSalesReport() {
  const [start, setStart] = useState(firstOfMonth());
  const [end, setEnd] = useState(today());
  const [rows, setRows] = useState<RawRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grouped, setGrouped] = useState(false);

  async function runReport() {
    setLoading(true); setError(null); setRows(null);
    try {
      const res = await fetch(`/api/keg-sales?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setRows(data.rows);
    } catch (e) { setError(e instanceof Error ? e.message : "Unknown error"); }
    finally { setLoading(false); }
  }

  const salesRows = rows?.filter((r) => !r.is_transfer) ?? [];
  const totals = {
    sales_qty: salesRows.reduce((s, r) => s + r.qty, 0),
    transfer_qty: rows?.filter((r) => r.is_transfer).reduce((s, r) => s + r.qty, 0) ?? 0,
    gross: salesRows.reduce((s, r) => s + parseFloat(r.gross_sales), 0),
    disc: salesRows.reduce((s, r) => s + parseFloat(r.discounts), 0),
    net: salesRows.reduce((s, r) => s + parseFloat(r.net_sales), 0),
    tax: salesRows.reduce((s, r) => s + parseFloat(r.tax), 0),
  };

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

      {rows !== null && (
        <div className="mt-4">
          <p className="text-sm text-gray-600 mb-3">
            {rows.length === 0 ? "No keg sales found for this period." : `${salesRows.length} sale${salesRows.length !== 1 ? "s" : ""}, ${totals.transfer_qty} transfer${totals.transfer_qty !== 1 ? "s" : ""}`}
          </p>

          {rows.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
              <table className="min-w-full text-sm">
                {grouped ? (
                  <>
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-50">
                        <th className="px-4 py-3 text-left font-medium text-gray-700">Beer</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-700">Size</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-700">Sales Qty</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-700">Transfers</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-700">Gross Sales</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-700">Discounts</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-700">Net Sales</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-700">Tax</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupByItem(rows).map((row, i) => (
                        <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="px-4 py-2 font-medium text-gray-900">{row.beer}</td>
                          <td className="px-4 py-2 text-gray-600">{row.size}</td>
                          <td className="px-4 py-2 text-right text-gray-700">{row.sales_qty}</td>
                          <td className="px-4 py-2 text-right text-amber-700">{row.transfer_qty || "—"}</td>
                          <td className="px-4 py-2 text-right text-gray-700">{currency(row.gross_sales)}</td>
                          <td className="px-4 py-2 text-right text-gray-500">{currency(row.discounts)}</td>
                          <td className="px-4 py-2 text-right font-medium text-gray-900">{currency(row.net_sales)}</td>
                          <td className="px-4 py-2 text-right text-gray-500">{currency(row.tax)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                        <td className="px-4 py-3 text-gray-700" colSpan={2}>Totals</td>
                        <td className="px-4 py-3 text-right text-gray-700">{totals.sales_qty}</td>
                        <td className="px-4 py-3 text-right text-amber-700">{totals.transfer_qty}</td>
                        <td className="px-4 py-3 text-right text-gray-700">{currency(totals.gross)}</td>
                        <td className="px-4 py-3 text-right text-gray-500">{currency(totals.disc)}</td>
                        <td className="px-4 py-3 text-right text-gray-900">{currency(totals.net)}</td>
                        <td className="px-4 py-3 text-right text-gray-500">{currency(totals.tax)}</td>
                      </tr>
                    </tfoot>
                  </>
                ) : (
                  <>
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-50">
                        <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-700">Time</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-700">Beer</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-700">Size</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-700">Qty</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-700">Gross Sales</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-700">Discounts</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-700">Net Sales</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-700">Tax</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={i} className={`border-b border-gray-100 hover:bg-gray-50 ${row.is_transfer ? "bg-amber-50" : ""}`}>
                          <td className="px-4 py-2 text-gray-700 whitespace-nowrap">{row.date}</td>
                          <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{row.time}</td>
                          <td className="px-4 py-2 font-medium text-gray-900">{row.beer}</td>
                          <td className="px-4 py-2 text-gray-600">{row.size}</td>
                          <td className="px-4 py-2 text-right text-gray-700">{row.qty}</td>
                          <td className="px-4 py-2">
                            {row.is_transfer
                              ? <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">Transfer</span>
                              : <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">Sale</span>}
                          </td>
                          <td className="px-4 py-2 text-right text-gray-700">{row.is_transfer ? "—" : currency(row.gross_sales)}</td>
                          <td className="px-4 py-2 text-right text-gray-500">{row.is_transfer ? "—" : currency(row.discounts)}</td>
                          <td className="px-4 py-2 text-right font-medium text-gray-900">{row.is_transfer ? "—" : currency(row.net_sales)}</td>
                          <td className="px-4 py-2 text-right text-gray-500">{row.is_transfer ? "—" : currency(row.tax)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                        <td className="px-4 py-3" colSpan={4}>Totals (Sales only)</td>
                        <td className="px-4 py-3 text-right text-gray-700">{totals.sales_qty}</td>
                        <td className="px-4 py-3" />
                        <td className="px-4 py-3 text-right text-gray-700">{currency(totals.gross)}</td>
                        <td className="px-4 py-3 text-right text-gray-500">{currency(totals.disc)}</td>
                        <td className="px-4 py-3 text-right text-gray-900">{currency(totals.net)}</td>
                        <td className="px-4 py-3 text-right text-gray-500">{currency(totals.tax)}</td>
                      </tr>
                    </tfoot>
                  </>
                )}
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
