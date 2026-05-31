"use client";

import { useState } from "react";

type Row = {
  date: string;
  time: string;
  item: string;
  variation: string;
  qty: number;
  gross_sales: string;
  discounts: string;
  net_sales: string;
  tax: string;
  order_id: string;
};

const COLUMNS: { key: keyof Row; label: string; align?: "right" }[] = [
  { key: "date", label: "Date" },
  { key: "time", label: "Time" },
  { key: "item", label: "Item" },
  { key: "variation", label: "Variation" },
  { key: "qty", label: "Qty", align: "right" },
  { key: "gross_sales", label: "Gross Sales", align: "right" },
  { key: "discounts", label: "Discounts", align: "right" },
  { key: "net_sales", label: "Net Sales", align: "right" },
  { key: "tax", label: "Tax", align: "right" },
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function exportCSV(rows: Row[]) {
  const header = COLUMNS.map((c) => c.label).join(",");
  const body = rows
    .map((r) =>
      COLUMNS.map((c) => {
        const v = String(r[c.key]);
        return v.includes(",") ? `"${v}"` : v;
      }).join(",")
    )
    .join("\n");
  const blob = new Blob([header + "\n" + body], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "combo-sales.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function currency(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function Home() {
  const [start, setStart] = useState(firstOfMonth());
  const [end, setEnd] = useState(today());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runReport() {
    setLoading(true);
    setError(null);
    setRows(null);
    try {
      const res = await fetch(`/api/combo-sales?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setRows(data.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  const totals = rows
    ? {
        qty: rows.reduce((s, r) => s + r.qty, 0),
        gross_sales: rows.reduce((s, r) => s + parseFloat(r.gross_sales), 0),
        discounts: rows.reduce((s, r) => s + parseFloat(r.discounts), 0),
        net_sales: rows.reduce((s, r) => s + parseFloat(r.net_sales), 0),
        tax: rows.reduce((s, r) => s + parseFloat(r.tax), 0),
      }
    : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">TPB Square Reports</h1>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h2 className="text-lg font-medium text-gray-800 mb-4">Combo Sales Report</h2>

          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Start Date</label>
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">End Date</label>
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={runReport}
              disabled={loading}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Loading…" : "Run Report"}
            </button>
            {rows && rows.length > 0 && (
              <button
                onClick={() => exportCSV(rows)}
                className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50"
              >
                Export CSV
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>
        )}

        {rows !== null && (
          <>
            <div className="text-sm text-gray-500 mb-3">
              {rows.length === 0
                ? "No combo sales found for this period."
                : `${rows.length} line item${rows.length !== 1 ? "s" : ""}`}
            </div>

            {rows.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      {COLUMNS.map((c) => (
                        <th
                          key={c.key}
                          className={`px-4 py-3 font-medium text-gray-600 whitespace-nowrap ${c.align === "right" ? "text-right" : "text-left"}`}
                        >
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="px-4 py-2 text-gray-700 whitespace-nowrap">{row.date}</td>
                        <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{row.time}</td>
                        <td className="px-4 py-2 text-gray-900 font-medium">{row.item}</td>
                        <td className="px-4 py-2 text-gray-600">{row.variation}</td>
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
                      <td className="px-4 py-3 text-gray-700" colSpan={4}>
                        Totals
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">{totals!.qty}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{currency(totals!.gross_sales)}</td>
                      <td className="px-4 py-3 text-right text-gray-500">{currency(totals!.discounts)}</td>
                      <td className="px-4 py-3 text-right text-gray-900">{currency(totals!.net_sales)}</td>
                      <td className="px-4 py-3 text-right text-gray-500">{currency(totals!.tax)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
