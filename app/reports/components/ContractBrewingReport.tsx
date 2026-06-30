"use client";

import { useState } from "react";
import { formatCurrency } from "@/lib/format";
import ReportControls from "./ReportControls";
import { useSort, SortTh } from "./SortControls";

type CategoryRow = { category: string; gross_sales: string; discounts: string; net_sales: string };
type CustomerRow  = { customer: string; invoices: number; total_charged: string; total_outstanding: string };

function currency(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return formatCurrency(n);
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

const tdCls = "px-4 py-2";

interface Props { start: string; end: string; onStartChange: (v: string) => void; onEndChange: (v: string) => void; }

export default function ContractBrewingReport({ start, end, onStartChange, onEndChange }: Props) {
  const [catRows, setCatRows]     = useState<CategoryRow[] | null>(null);
  const [custRows, setCustRows]   = useState<CustomerRow[] | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const catSort  = useSort(catRows);
  const custSort = useSort(custRows);
  const catSp  = { sortKey: catSort.sortKey,  sortDir: catSort.sortDir,  onSort: catSort.handleSort };
  const custSp = { sortKey: custSort.sortKey, sortDir: custSort.sortDir, onSort: custSort.handleSort };

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
        start={start} end={end} onStartChange={onStartChange} onEndChange={onEndChange}
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
                    <SortTh label="Category"      col="category"   {...catSp} />
                    <SortTh label="Gross Revenue" col="gross_sales" {...catSp} align="right" />
                    <SortTh label="Net Revenue"   col="net_sales"   {...catSp} align="right" />
                  </tr>
                </thead>
                <tbody className="bg-zinc-900">
                  {(catSort.sorted ?? []).map((row, i) => (
                    <tr key={i} className="border-b border-zinc-800 hover:bg-zinc-800">
                      <td className={`${tdCls} font-medium text-zinc-100`}>{row.category}</td>
                      <td className={`${tdCls} text-right text-zinc-200`}>{currency(row.gross_sales)}</td>
                      <td className={`${tdCls} text-right font-medium text-zinc-100`}>{currency(row.net_sales)}</td>
                    </tr>
                  ))}
                </tbody>
                {catTotals && (
                  <tfoot>
                    <tr className="border-t-2 border-zinc-600 bg-zinc-800 font-semibold">
                      <td className={`${tdCls} text-zinc-200`}>Total</td>
                      <td className={`${tdCls} text-right text-zinc-200`}>{currency(catTotals.gross)}</td>
                      <td className={`${tdCls} text-right text-zinc-100`}>{currency(catTotals.net)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {catTotals && catTotals.disc > 0 && (
              <div className="mt-3 inline-flex items-center gap-3 px-4 py-3 bg-zinc-900 border border-zinc-700 rounded-lg">
                <span className="text-sm font-medium text-zinc-300">Total Discounts Applied</span>
                <span className="text-lg font-semibold text-amber-400">{currency(catTotals.disc)}</span>
              </div>
            )}
          </div>

          {/* By Customer */}
          {custRows && custRows.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">By Customer</h3>
              <div className="overflow-x-auto rounded-lg border border-zinc-700">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-700 bg-zinc-800">
                      <SortTh label="Customer"    col="customer"          {...custSp} />
                      <SortTh label="Invoices"    col="invoices"          {...custSp} align="right" />
                      <SortTh label="Total Charged"    col="total_charged"     {...custSp} align="right" />
                      <SortTh label="Outstanding" col="total_outstanding" {...custSp} align="right" />
                    </tr>
                  </thead>
                  <tbody className="bg-zinc-900">
                    {(custSort.sorted ?? []).map((row, i) => (
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
