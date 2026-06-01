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
function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function exportCSV(rows: CategoryRow[], tips: string) {
  const lines = [
    "Category,Gross Sales,Discounts,Returns,Net Sales,Tax Collected",
    ...rows.map(r => `"${r.category}",${r.gross_sales},${r.discounts},${r.returns},${r.net_sales},${r.tax}`),
    `"Total Tips",${tips},,,,`,
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "taproom-model.csv"; a.click();
  URL.revokeObjectURL(url);
}

const thCls = "px-4 py-3 font-medium text-zinc-300";
const tdCls = "px-4 py-2";

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
    gross:     rows.reduce((s, r) => s + parseFloat(r.gross_sales), 0),
    discounts: rows.reduce((s, r) => s + parseFloat(r.discounts),   0),
    returns:   rows.reduce((s, r) => s + parseFloat(r.returns),     0),
    net:       rows.reduce((s, r) => s + parseFloat(r.net_sales),   0),
    tax:       rows.reduce((s, r) => s + parseFloat(r.tax),         0),
  } : null;

  return (
    <div>
      <ReportControls
        start={start} end={end} onStartChange={setStart} onEndChange={setEnd}
        onRun={runReport} loading={loading} hasData={hasData}
        onExport={() => rows && tips !== null && exportCSV(rows, tips)}
        groupBy="none" groupOptions={[]} onGroupByChange={() => {}}
      />

      {error && (
        <div className="mt-4 p-3 bg-red-950 border border-red-700 rounded-md text-sm text-red-300">{error}</div>
      )}

      {rows !== null && (
        <div className="mt-4 space-y-4">
          <div className="overflow-x-auto rounded-lg border border-zinc-700">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-700 bg-zinc-800">
                  <th className={`${thCls} text-left`}>Category</th>
                  <th className={`${thCls} text-right`}>Gross Sales</th>
                  <th className={`${thCls} text-right`}>Discounts</th>
                  <th className={`${thCls} text-right`}>Returns</th>
                  <th className={`${thCls} text-right`}>Net Sales</th>
                  <th className={`${thCls} text-right`}>Tax Collected</th>
                </tr>
              </thead>
              <tbody className="bg-zinc-900">
                {rows.map((row, i) => {
                  const isZero = parseFloat(row.gross_sales) === 0 && parseFloat(row.net_sales) === 0;
                  return (
                    <tr key={i} className="border-b border-zinc-800 hover:bg-zinc-800">
                      <td className={`${tdCls} font-medium ${isZero ? "text-zinc-600" : "text-zinc-100"}`}>{row.category}</td>
                      <td className={`${tdCls} text-right ${isZero ? "text-zinc-600" : "text-zinc-200"}`}>{currency(row.gross_sales)}</td>
                      <td className={`${tdCls} text-right ${isZero ? "text-zinc-600" : "text-zinc-400"}`}>
                        {parseFloat(row.discounts) > 0 ? currency(row.discounts) : "—"}
                      </td>
                      <td className={`${tdCls} text-right ${parseFloat(row.returns) > 0 ? "text-red-400" : "text-zinc-600"}`}>
                        {parseFloat(row.returns) > 0 ? currency(row.returns) : "—"}
                      </td>
                      <td className={`${tdCls} text-right font-medium ${isZero ? "text-zinc-600" : "text-zinc-100"}`}>{currency(row.net_sales)}</td>
                      <td className={`${tdCls} text-right ${isZero ? "text-zinc-600" : "text-zinc-400"}`}>
                        {parseFloat(row.tax) > 0 ? currency(row.tax) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {grandTotals && (
                <tfoot>
                  <tr className="border-t-2 border-zinc-600 bg-zinc-800 font-semibold">
                    <td className={`${tdCls} text-zinc-200`}>Total</td>
                    <td className={`${tdCls} text-right text-zinc-200`}>{currency(grandTotals.gross)}</td>
                    <td className={`${tdCls} text-right text-zinc-400`}>{currency(grandTotals.discounts)}</td>
                    <td className={`${tdCls} text-right ${grandTotals.returns > 0 ? "text-red-400" : "text-zinc-600"}`}>
                      {grandTotals.returns > 0 ? currency(grandTotals.returns) : "—"}
                    </td>
                    <td className={`${tdCls} text-right text-zinc-100`}>{currency(grandTotals.net)}</td>
                    <td className={`${tdCls} text-right text-zinc-400`}>{currency(grandTotals.tax)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {tips !== null && (
            <div className="inline-flex items-center gap-3 px-4 py-3 bg-zinc-900 border border-zinc-700 rounded-lg">
              <span className="text-sm font-medium text-zinc-300">Total Tips Collected</span>
              <span className="text-lg font-semibold text-zinc-100">{currency(tips)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
