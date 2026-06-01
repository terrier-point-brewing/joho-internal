"use client";

import { useState } from "react";
import ReportControls from "./ReportControls";

type Row = {
  date: string; time: string; name: string; qty: number;
  face_value: string; gross_sales: string; discounts: string;
  discount_names: string[]; net_sales: string; tax: string; order_id: string;
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

function exportCSV(rows: Row[]) {
  const csv = [
    "Date,Time,Name,Qty,Face Value,Gross Sales,Discounts,Discount Notes,Net Sales,Tax",
    ...rows.map(r =>
      `${r.date},${r.time},"${r.name}",${r.qty},${r.face_value},${r.gross_sales},${r.discounts},"${r.discount_names.join("; ")}",${r.net_sales},${r.tax}`
    ),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "gift-card-sales.csv"; a.click();
  URL.revokeObjectURL(url);
}

const thCls = "px-4 py-3 font-medium text-zinc-300";
const tdCls = "px-4 py-2";

export default function GiftCardReport() {
  const [start, setStart] = useState(firstOfMonth());
  const [end, setEnd]     = useState(today());
  const [rows, setRows]   = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  async function runReport() {
    setLoading(true); setError(null); setRows(null);
    try {
      const res = await fetch(`/api/gift-cards?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setRows(data.rows);
    } catch (e) { setError(e instanceof Error ? e.message : "Unknown error"); }
    finally { setLoading(false); }
  }

  const totals = rows ? {
    qty:   rows.reduce((s, r) => s + r.qty, 0),
    face:  rows.reduce((s, r) => s + parseFloat(r.face_value), 0),
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
        onExport={() => rows && exportCSV(rows)}
        groupBy="none" groupOptions={[]} onGroupByChange={() => {}}
      />

      {error && (
        <div className="mt-4 p-3 bg-red-950 border border-red-700 rounded-md text-sm text-red-300">{error}</div>
      )}

      {rows !== null && (
        <div className="mt-4">
          <p className="text-sm text-zinc-400 mb-3">
            {rows.length === 0
              ? "No gift card sales found for this period."
              : `${rows.length} transaction${rows.length !== 1 ? "s" : ""}`}
          </p>
          {rows.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-zinc-700">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-700 bg-zinc-800">
                    <th className={`${thCls} text-left`}>Date</th>
                    <th className={`${thCls} text-left`}>Time</th>
                    <th className={`${thCls} text-left`}>Name</th>
                    <th className={`${thCls} text-right`}>Qty</th>
                    <th className={`${thCls} text-right`}>Face Value</th>
                    <th className={`${thCls} text-right`}>Gross Sales</th>
                    <th className={`${thCls} text-right`}>Discounts</th>
                    <th className={`${thCls} text-left`}>Discount Notes</th>
                    <th className={`${thCls} text-right`}>Net Sales</th>
                    <th className={`${thCls} text-right`}>Tax</th>
                  </tr>
                </thead>
                <tbody className="bg-zinc-900">
                  {rows.map((row, i) => {
                    const isComped = parseFloat(row.net_sales) === 0;
                    return (
                      <tr key={i} className="border-b border-zinc-800 hover:bg-zinc-800">
                        <td className={`${tdCls} text-zinc-200 whitespace-nowrap`}>{row.date}</td>
                        <td className={`${tdCls} text-zinc-400 whitespace-nowrap`}>{row.time}</td>
                        <td className={`${tdCls} font-medium text-zinc-100`}>{row.name}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{row.qty}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{currency(row.face_value)}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{currency(row.gross_sales)}</td>
                        <td className={`${tdCls} text-right ${parseFloat(row.discounts) > 0 ? "text-amber-400" : "text-zinc-600"}`}>
                          {parseFloat(row.discounts) > 0 ? currency(row.discounts) : "—"}
                        </td>
                        <td className={`${tdCls} text-zinc-400 text-xs`}>
                          {row.discount_names.length > 0 ? row.discount_names.join(", ") : "—"}
                        </td>
                        <td className={`${tdCls} text-right font-medium ${isComped ? "text-zinc-500" : "text-zinc-100"}`}>
                          {currency(row.net_sales)}
                        </td>
                        <td className={`${tdCls} text-right text-zinc-400`}>
                          {parseFloat(row.tax) > 0 ? currency(row.tax) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-zinc-600 bg-zinc-800 font-semibold">
                    <td className={tdCls} colSpan={3}><span className="text-zinc-200">Totals</span></td>
                    <td className={`${tdCls} text-right text-zinc-200`}>{totals!.qty}</td>
                    <td className={`${tdCls} text-right text-zinc-200`}>{currency(totals!.face)}</td>
                    <td className={`${tdCls} text-right text-zinc-200`}>{currency(totals!.gross)}</td>
                    <td className={`${tdCls} text-right text-amber-400`}>{currency(totals!.disc)}</td>
                    <td className={tdCls} />
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
