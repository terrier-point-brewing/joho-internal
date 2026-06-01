"use client";

import { useState } from "react";
import ReportControls from "./ReportControls";

type CategoryRow = {
  category: string;
  gross_sales: string;
  discounts: string;
  returns: string;
  net_sales: string;
  tax: string;
};

function currency(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function today() { return new Date().toISOString().slice(0, 10); }
function firstOfMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; }

function exportCSV(rows: CategoryRow[], tips: string) {
  const lines = [
    "Category,Gross Sales,Discounts,Returns,Net Sales,Tax Collected",
    ...rows.map(r => `"${r.category}",${r.gross_sales},${r.discounts},${r.returns},${r.net_sales},${r.tax}`),
    `"Total Tips",${tips},,,, `,
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "taproom-model.csv"; a.click();
  URL.revokeObjectURL(url);
}

export default function TaproomModelReport() {
  const [start, setStart]     = useState(firstOfMonth());
  const [end, setEnd]         = useState(today());
  const [rows, setRows]       = useState<CategoryRow[] | null>(null);
  const [tips, setTips]       = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  async function runReport() {
    setLoading(true); setError(null); setRows(null); setTips(null);
    try {
      const res = await fetch(`/api/taproom-model?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setRows(data.rows);
      setTips(data.total_tips);
    } catch (e) { setError(e instanceof Error ? e.message : "Unknown error"); }
    finally { setLoading(false); }
  }

  const hasData = !!rows?.length;
  const grandTotals = rows ? {
    gross:    rows.reduce((s, r) => s + parseFloat(r.gross_sales), 0),
    discounts: rows.reduce((s, r) => s + parseFloat(r.discounts), 0),
    returns:  rows.reduce((s, r) => s + parseFloat(r.returns), 0),
    net:      rows.reduce((s, r) => s + parseFloat(r.net_sales), 0),
    tax:      rows.reduce((s, r) => s + parseFloat(r.tax), 0),
  } : null;

  return (
    <div>
      <ReportControls
        start={start} end={end} onStartChange={setStart} onEndChange={setEnd}
        onRun={runReport} loading={loading} hasData={hasData}
        onExport={() => rows && tips !== null && exportCSV(rows, tips)}
        groupBy="none" groupOptions={[]} onGroupByChange={() => {}}
      />

      {error && <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>}

      {rows !== null && (
        <div className="mt-4 space-y-4">
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Category</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Gross Sales</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Discounts</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Returns</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Net Sales</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Tax Collected</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const isZero = parseFloat(row.gross_sales) === 0 && parseFloat(row.net_sales) === 0;
                  return (
                    <tr key={i} className={`border-b border-gray-100 hover:bg-gray-50 ${isZero ? "text-gray-400" : ""}`}>
                      <td className={`px-4 py-2 font-medium ${isZero ? "text-gray-400" : "text-gray-900"}`}>{row.category}</td>
                      <td className="px-4 py-2 text-right">{currency(row.gross_sales)}</td>
                      <td className="px-4 py-2 text-right text-gray-500">{parseFloat(row.discounts) > 0 ? currency(row.discounts) : "—"}</td>
                      <td className="px-4 py-2 text-right text-red-600">{parseFloat(row.returns) > 0 ? currency(row.returns) : "—"}</td>
                      <td className={`px-4 py-2 text-right font-medium ${isZero ? "text-gray-400" : "text-gray-900"}`}>{currency(row.net_sales)}</td>
                      <td className="px-4 py-2 text-right text-gray-500">{parseFloat(row.tax) > 0 ? currency(row.tax) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
              {grandTotals && (
                <tfoot>
                  <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                    <td className="px-4 py-3 text-gray-700">Total</td>
                    <td className="px-4 py-3 text-right text-gray-700">{currency(grandTotals.gross)}</td>
                    <td className="px-4 py-3 text-right text-gray-500">{currency(grandTotals.discounts)}</td>
                    <td className="px-4 py-3 text-right text-red-600">{grandTotals.returns > 0 ? currency(grandTotals.returns) : "—"}</td>
                    <td className="px-4 py-3 text-right text-gray-900">{currency(grandTotals.net)}</td>
                    <td className="px-4 py-3 text-right text-gray-500">{currency(grandTotals.tax)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {tips !== null && (
            <div className="inline-flex items-center gap-3 px-4 py-3 bg-white border border-gray-200 rounded-lg">
              <span className="text-sm font-medium text-gray-700">Total Tips Collected</span>
              <span className="text-lg font-semibold text-gray-900">{currency(tips)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
