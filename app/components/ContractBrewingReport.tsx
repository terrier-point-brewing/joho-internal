"use client";

import { useState } from "react";
import ReportControls from "./ReportControls";

type CategoryRow = { category: string; gross_sales: string; discounts: string; net_sales: string };
type CustomerRow  = { customer: string; invoices: number; total_charged: string; total_outstanding: string };

function currency(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function today() { return new Date().toISOString().slice(0, 10); }
function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function exportCSV(catRows: CategoryRow[], custRows: CustomerRow[]) {
  const lines = [
    "--- Revenue by Category ---",
    "Category,Gross Sales,Discounts,Net Sales",
    ...catRows.map(r => `"${r.category}",${r.gross_sales},${r.discounts},${r.net_sales}`),
    "",
    "--- By Customer ---",
    "Customer,Invoices,Total Charged,Total Outstanding",
    ...custRows.map(r => `"${r.customer}",${r.invoices},${r.total_charged},${r.total_outstanding}`),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "contract-brewing.csv"; a.click();
  URL.revokeObjectURL(url);
}

const thCls = "px-4 py-3 font-medium text-zinc-300";
const tdCls = "px-4 py-2";

export default function ContractBrewingReport() {
  const [start, setStart]         = useState(firstOfMonth());
  const [end, setEnd]             = useState(today());
  const [catRows, setCatRows]     = useState<CategoryRow[] | null>(null);
  const [custRows, setCustRows]   = useState<CustomerRow[] | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  async function runReport() {
    setLoading(true); setError(null); setCatRows(null); setCustRows(null);
    try {
      const res  = await fetch(`/api/contract-brewing?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setCatRows(data.by_category);
      setCustRows(data.by_customer);
    } catch (e) { setError(e instanceof Error ? e.message : "Unknown error"); }
    finally { setLoading(false); }
  }

  const hasData = !!catRows;
  const catTotals = catRows ? {
    gross: catRows.reduce((s, r) => s + parseFloat(r.gross_sales), 0),
    disc:  catRows.reduce((s, r) => s + parseFloat(r.discounts),   0),
    net:   catRows.reduce((s, r) => s + parseFloat(r.net_sales),   0),
  } : null;

  return (
    <div>
      <ReportControls
        start={start} end={end} onStartChange={setStart} onEndChange={setEnd}
        onRun={runReport} loading={loading} hasData={hasData}
        onExport={() => catRows && custRows && exportCSV(catRows, custRows)}
        groupBy="none" groupOptions={[]} onGroupByChange={() => {}}
      />

      {error && <div className="mt-4 p-3 bg-red-950 border border-red-700 rounded-md text-sm text-red-300">{error}</div>}

      {catRows !== null && (
        <div className="mt-4 space-y-6">

          {/* Revenue by Category */}
          <div>
            <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">Revenue by Category</h3>
            <div className="overflow-x-auto rounded-lg border border-zinc-700">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-700 bg-zinc-800">
                    <th className={`${thCls} text-left`}>Category</th>
                    <th className={`${thCls} text-right`}>Gross Revenue</th>
                    <th className={`${thCls} text-right`}>Discounts</th>
                    <th className={`${thCls} text-right`}>Net Revenue</th>
                  </tr>
                </thead>
                <tbody className="bg-zinc-900">
                  {catRows.map((row, i) => (
                    <tr key={i} className="border-b border-zinc-800 hover:bg-zinc-800">
                      <td className={`${tdCls} font-medium text-zinc-100`}>{row.category}</td>
                      <td className={`${tdCls} text-right text-zinc-200`}>{currency(row.gross_sales)}</td>
                      <td className={`${tdCls} text-right ${parseFloat(row.discounts) > 0 ? "text-amber-400" : "text-zinc-600"}`}>
                        {parseFloat(row.discounts) > 0 ? currency(row.discounts) : "—"}
                      </td>
                      <td className={`${tdCls} text-right font-medium text-zinc-100`}>{currency(row.net_sales)}</td>
                    </tr>
                  ))}
                </tbody>
                {catTotals && (
                  <tfoot>
                    <tr className="border-t-2 border-zinc-600 bg-zinc-800 font-semibold">
                      <td className={`${tdCls} text-zinc-200`}>Total</td>
                      <td className={`${tdCls} text-right text-zinc-200`}>{currency(catTotals.gross)}</td>
                      <td className={`${tdCls} text-right text-amber-400`}>{catTotals.disc > 0 ? currency(catTotals.disc) : "—"}</td>
                      <td className={`${tdCls} text-right text-zinc-100`}>{currency(catTotals.net)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {/* By Customer */}
          {custRows && custRows.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">By Customer</h3>
              <div className="overflow-x-auto rounded-lg border border-zinc-700">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-700 bg-zinc-800">
                      <th className={`${thCls} text-left`}>Customer</th>
                      <th className={`${thCls} text-right`}>Invoices</th>
                      <th className={`${thCls} text-right`}>Total Charged</th>
                      <th className={`${thCls} text-right`}>Outstanding</th>
                    </tr>
                  </thead>
                  <tbody className="bg-zinc-900">
                    {custRows.map((row, i) => (
                      <tr key={i} className="border-b border-zinc-800 hover:bg-zinc-800">
                        <td className={`${tdCls} font-medium text-zinc-100`}>{row.customer}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{row.invoices}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{currency(row.total_charged)}</td>
                        <td className={`${tdCls} text-right font-medium ${parseFloat(row.total_outstanding) > 0 ? "text-amber-400" : "text-zinc-500"}`}>
                          {parseFloat(row.total_outstanding) > 0 ? currency(row.total_outstanding) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-zinc-600 bg-zinc-800 font-semibold">
                      <td className={`${tdCls} text-zinc-200`}>Total</td>
                      <td className={`${tdCls} text-right text-zinc-200`}>{custRows.reduce((s, r) => s + r.invoices, 0)}</td>
                      <td className={`${tdCls} text-right text-zinc-200`}>{currency(custRows.reduce((s, r) => s + parseFloat(r.total_charged), 0))}</td>
                      <td className={`${tdCls} text-right text-amber-400`}>{currency(custRows.reduce((s, r) => s + parseFloat(r.total_outstanding), 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {catRows.every(r => parseFloat(r.gross_sales) === 0) && (
            <p className="text-sm text-zinc-500">No contract brewing invoices found for this period.</p>
          )}
        </div>
      )}
    </div>
  );
}
