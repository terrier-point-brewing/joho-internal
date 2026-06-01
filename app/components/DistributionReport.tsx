"use client";

import { useState } from "react";
import ReportControls from "./ReportControls";

type SizeRow     = { size: string; qty: number; gross_sales: string; discounts: string; net_sales: string };
type CustomerRow = {
  customer: string; invoices: number;
  total_charged: string; total_outstanding: string;
  half_keg_qty: number; sixth_keg_qty: number; quarter_keg_qty: number; cans_qty: number;
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

function exportCSV(sizeRows: SizeRow[], custRows: CustomerRow[]) {
  const lines = [
    "--- Revenue by Size ---",
    "Size,Qty,Gross Sales,Discounts,Net Sales",
    ...sizeRows.map(r => `"${r.size}",${r.qty},${r.gross_sales},${r.discounts},${r.net_sales}`),
    "",
    "--- By Customer ---",
    "Customer,Invoices,Total Charged,Total Outstanding,1/2 Kegs,1/6 Kegs,1/4 Kegs,Cans",
    ...custRows.map(r => `"${r.customer}",${r.invoices},${r.total_charged},${r.total_outstanding},${r.half_keg_qty},${r.sixth_keg_qty},${r.quarter_keg_qty},${r.cans_qty}`),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "distribution.csv"; a.click();
  URL.revokeObjectURL(url);
}

const thCls = "px-4 py-3 font-medium text-zinc-300";
const tdCls = "px-4 py-2";

export default function DistributionReport() {
  const [start, setStart]         = useState(firstOfMonth());
  const [end, setEnd]             = useState(today());
  const [sizeRows, setSizeRows]   = useState<SizeRow[] | null>(null);
  const [custRows, setCustRows]   = useState<CustomerRow[] | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  async function runReport() {
    setLoading(true); setError(null); setSizeRows(null); setCustRows(null);
    try {
      const res  = await fetch(`/api/distribution?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setSizeRows(data.by_size);
      setCustRows(data.by_customer);
    } catch (e) { setError(e instanceof Error ? e.message : "Unknown error"); }
    finally { setLoading(false); }
  }

  const hasData = !!sizeRows;
  const sizeTotals = sizeRows ? {
    qty:   sizeRows.reduce((s, r) => s + r.qty, 0),
    gross: sizeRows.reduce((s, r) => s + parseFloat(r.gross_sales), 0),
    disc:  sizeRows.reduce((s, r) => s + parseFloat(r.discounts),   0),
    net:   sizeRows.reduce((s, r) => s + parseFloat(r.net_sales),   0),
  } : null;

  return (
    <div>
      <ReportControls
        start={start} end={end} onStartChange={setStart} onEndChange={setEnd}
        onRun={runReport} loading={loading} hasData={hasData}
        onExport={() => sizeRows && custRows && exportCSV(sizeRows, custRows)}
        groupBy="none" groupOptions={[]} onGroupByChange={() => {}}
      />

      {error && <div className="mt-4 p-3 bg-red-950 border border-red-700 rounded-md text-sm text-red-300">{error}</div>}

      {sizeRows !== null && (
        <div className="mt-4 space-y-6">

          {/* Revenue by Size */}
          <div>
            <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">Revenue by Size</h3>
            {sizeRows.length === 0 ? (
              <p className="text-sm text-zinc-500">No distribution invoices found for this period.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-zinc-700">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-700 bg-zinc-800">
                      <th className={`${thCls} text-left`}>Size</th>
                      <th className={`${thCls} text-right`}>Qty</th>
                      <th className={`${thCls} text-right`}>Gross Sales</th>
                      <th className={`${thCls} text-right`}>Discounts</th>
                      <th className={`${thCls} text-right`}>Net Sales</th>
                    </tr>
                  </thead>
                  <tbody className="bg-zinc-900">
                    {sizeRows.map((row, i) => (
                      <tr key={i} className="border-b border-zinc-800 hover:bg-zinc-800">
                        <td className={`${tdCls} font-medium text-zinc-100`}>{row.size}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{row.qty}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{currency(row.gross_sales)}</td>
                        <td className={`${tdCls} text-right ${parseFloat(row.discounts) > 0 ? "text-amber-400" : "text-zinc-600"}`}>
                          {parseFloat(row.discounts) > 0 ? currency(row.discounts) : "—"}
                        </td>
                        <td className={`${tdCls} text-right font-medium text-zinc-100`}>{currency(row.net_sales)}</td>
                      </tr>
                    ))}
                  </tbody>
                  {sizeTotals && (
                    <tfoot>
                      <tr className="border-t-2 border-zinc-600 bg-zinc-800 font-semibold">
                        <td className={`${tdCls} text-zinc-200`}>Total</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{sizeTotals.qty}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{currency(sizeTotals.gross)}</td>
                        <td className={`${tdCls} text-right text-amber-400`}>{sizeTotals.disc > 0 ? currency(sizeTotals.disc) : "—"}</td>
                        <td className={`${tdCls} text-right text-zinc-100`}>{currency(sizeTotals.net)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
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
                      <th className={`${thCls} text-left`}>Customer</th>
                      <th className={`${thCls} text-right`}>Invoices</th>
                      <th className={`${thCls} text-right`}>Total Charged</th>
                      <th className={`${thCls} text-right`}>Outstanding</th>
                      <th className={`${thCls} text-right`}>1/2 Kegs</th>
                      <th className={`${thCls} text-right`}>1/6 Kegs</th>
                      <th className={`${thCls} text-right`}>1/4 Kegs</th>
                      <th className={`${thCls} text-right`}>Cans</th>
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
                        <td className={`${tdCls} text-right text-zinc-200`}>{row.half_keg_qty    || "—"}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{row.sixth_keg_qty   || "—"}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{row.quarter_keg_qty || "—"}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{row.cans_qty        || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-zinc-600 bg-zinc-800 font-semibold">
                      <td className={`${tdCls} text-zinc-200`}>Total</td>
                      <td className={`${tdCls} text-right text-zinc-200`}>{custRows.reduce((s, r) => s + r.invoices, 0)}</td>
                      <td className={`${tdCls} text-right text-zinc-200`}>{currency(custRows.reduce((s, r) => s + parseFloat(r.total_charged), 0))}</td>
                      <td className={`${tdCls} text-right text-amber-400`}>{currency(custRows.reduce((s, r) => s + parseFloat(r.total_outstanding), 0))}</td>
                      <td className={`${tdCls} text-right text-zinc-200`}>{custRows.reduce((s, r) => s + r.half_keg_qty, 0) || "—"}</td>
                      <td className={`${tdCls} text-right text-zinc-200`}>{custRows.reduce((s, r) => s + r.sixth_keg_qty, 0) || "—"}</td>
                      <td className={`${tdCls} text-right text-zinc-200`}>{custRows.reduce((s, r) => s + r.quarter_keg_qty, 0) || "—"}</td>
                      <td className={`${tdCls} text-right text-zinc-200`}>{custRows.reduce((s, r) => s + r.cans_qty, 0) || "—"}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
