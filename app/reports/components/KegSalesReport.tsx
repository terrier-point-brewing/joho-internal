"use client";

import { useState, useMemo } from "react";
import ReportControls from "./ReportControls";
import { useSort, SortTh } from "./SortControls";

type RawRow = {
  date: string; time: string; beer: string; size: string; qty: number;
  is_transfer: boolean; discount_names: string[];
  gross_sales: string; discounts: string; net_sales: string; tax: string;
};
type GroupedRow = {
  beer: string; size: string;
  sales_qty: number; transfer_qty: number;
  gross_sales: string; discounts: string; net_sales: string; tax: string;
};

const GROUP_OPTIONS = [
  { value: "date",     label: "Date"       },
  { value: "beer",     label: "Beer"       },
  { value: "beerSize", label: "Beer + Size"},
];

const KEG_SIZE_ORDER: Record<string, number> = { "1/6 Keg": 0, "1/4 Keg": 1, "1/2 Keg": 2 };

function currency(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function groupRows(rows: RawRow[], mode: "beer" | "beerSize"): GroupedRow[] {
  const map = new Map<string, GroupedRow>();
  for (const r of rows) {
    const key = mode === "beer" ? r.beer : `${r.beer}||${r.size}`;
    const cur = map.get(key);
    if (cur) {
      if (r.is_transfer) { cur.transfer_qty += r.qty; }
      else {
        cur.sales_qty   += r.qty;
        cur.gross_sales  = (parseFloat(cur.gross_sales) + parseFloat(r.gross_sales)).toFixed(2);
        cur.discounts    = (parseFloat(cur.discounts)   + parseFloat(r.discounts)).toFixed(2);
        cur.net_sales    = (parseFloat(cur.net_sales)   + parseFloat(r.net_sales)).toFixed(2);
        cur.tax          = (parseFloat(cur.tax)         + parseFloat(r.tax)).toFixed(2);
      }
    } else {
      map.set(key, {
        beer: r.beer, size: mode === "beer" ? "All" : r.size,
        sales_qty:    r.is_transfer ? 0 : r.qty,
        transfer_qty: r.is_transfer ? r.qty : 0,
        gross_sales: r.is_transfer ? "0.00" : r.gross_sales,
        discounts:   r.is_transfer ? "0.00" : r.discounts,
        net_sales:   r.is_transfer ? "0.00" : r.net_sales,
        tax:         r.is_transfer ? "0.00" : r.tax,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const n = a.beer.localeCompare(b.beer);
    return n !== 0 ? n : (KEG_SIZE_ORDER[a.size] ?? 99) - (KEG_SIZE_ORDER[b.size] ?? 99);
  });
}

function exportCSV(rows: RawRow[], groupBy: string) {
  let csv: string;
  if (groupBy === "beer" || groupBy === "beerSize") {
    const gr = groupRows(rows, groupBy as "beer" | "beerSize");
    const showSize = groupBy === "beerSize";
    const header = showSize
      ? "Beer,Size,Sales Qty,Transfers,Gross Sales,Discounts,Net Sales,Tax"
      : "Beer,Sales Qty,Transfers,Gross Sales,Discounts,Net Sales,Tax";
    csv = header + "\n" + gr.map(r =>
      showSize
        ? `"${r.beer}",${r.size},${r.sales_qty},${r.transfer_qty},${r.gross_sales},${r.discounts},${r.net_sales},${r.tax}`
        : `"${r.beer}",${r.sales_qty},${r.transfer_qty},${r.gross_sales},${r.discounts},${r.net_sales},${r.tax}`
    ).join("\n");
  } else {
    csv = "Date,Time,Beer,Size,Qty,Type,Gross Sales,Discounts,Net Sales,Tax\n" +
      rows.map(r => `${r.date},${r.time},"${r.beer}",${r.size},${r.qty},${r.is_transfer ? "Transfer" : "Sale"},${r.gross_sales},${r.discounts},${r.net_sales},${r.tax}`).join("\n");
  }
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "keg-sales.csv"; a.click();
  URL.revokeObjectURL(url);
}

const tdCls = "px-4 py-2";

interface Props { start: string; end: string; onStartChange: (v: string) => void; onEndChange: (v: string) => void; }

export default function KegSalesReport({ start, end, onStartChange, onEndChange }: Props) {
  const [rows, setRows]   = useState<RawRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState("date");

  const groupedRows = useMemo(
    () => (rows && (groupBy === "beer" || groupBy === "beerSize") ? groupRows(rows, groupBy as "beer" | "beerSize") : null),
    [rows, groupBy]
  );

  const rawSort     = useSort(rows);
  const groupedSort = useSort(groupedRows);

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

  const isGrouped = groupBy === "beer" || groupBy === "beerSize";
  const salesRows = rows?.filter(r => !r.is_transfer) ?? [];
  const totals = {
    sales_qty:    salesRows.reduce((s, r) => s + r.qty, 0),
    transfer_qty: rows?.filter(r => r.is_transfer).reduce((s, r) => s + r.qty, 0) ?? 0,
    gross: salesRows.reduce((s, r) => s + parseFloat(r.gross_sales), 0),
    disc:  salesRows.reduce((s, r) => s + parseFloat(r.discounts), 0),
    net:   salesRows.reduce((s, r) => s + parseFloat(r.net_sales), 0),
    tax:   salesRows.reduce((s, r) => s + parseFloat(r.tax), 0),
  };

  const sp = isGrouped
    ? { sortKey: groupedSort.sortKey, sortDir: groupedSort.sortDir, onSort: groupedSort.handleSort }
    : { sortKey: rawSort.sortKey,     sortDir: rawSort.sortDir,     onSort: rawSort.handleSort };

  return (
    <div>
      <ReportControls
        start={start} end={end} onStartChange={onStartChange} onEndChange={onEndChange}
        onRun={runReport} loading={loading} hasData={!!rows?.length}
        onExport={() => rows && exportCSV(rows, groupBy)}
        groupBy={groupBy} groupOptions={GROUP_OPTIONS} onGroupByChange={setGroupBy}
      />

      {error && (
        <div className="mt-4 p-3 bg-red-950 border border-red-700 rounded-md text-sm text-red-300">{error}</div>
      )}

      {rows !== null && (
        <div className="mt-4">
          <p className="text-sm text-zinc-400 mb-3">
            {rows.length === 0
              ? "No keg sales found."
              : `${salesRows.length} sale${salesRows.length !== 1 ? "s" : ""}, ${totals.transfer_qty} transfer${totals.transfer_qty !== 1 ? "s" : ""}`}
          </p>
          {rows.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-zinc-700">
              <table className="min-w-full text-sm">
                {isGrouped ? (
                  <>
                    <thead>
                      <tr className="border-b border-zinc-700 bg-zinc-800">
                        <SortTh label="Beer"        col="beer"        {...sp} />
                        {groupBy === "beerSize" && <SortTh label="Size" col="size" {...sp} />}
                        <SortTh label="Sales Qty"   col="sales_qty"   {...sp} align="right" />
                        <SortTh label="Transfers"   col="transfer_qty" {...sp} align="right" />
                        <SortTh label="Gross Sales" col="gross_sales" {...sp} align="right" />
                        <SortTh label="Discounts"   col="discounts"   {...sp} align="right" />
                        <SortTh label="Net Sales"   col="net_sales"   {...sp} align="right" />
                        <SortTh label="Tax"         col="tax"         {...sp} align="right" />
                      </tr>
                    </thead>
                    <tbody className="bg-zinc-900">
                      {(groupedSort.sorted ?? groupedRows ?? []).map((row, i) => (
                        <tr key={i} className="border-b border-zinc-800 hover:bg-zinc-800">
                          <td className={`${tdCls} font-medium text-zinc-100`}>{row.beer}</td>
                          {groupBy === "beerSize" && <td className={`${tdCls} text-zinc-300`}>{row.size}</td>}
                          <td className={`${tdCls} text-right text-zinc-200`}>{row.sales_qty || "—"}</td>
                          <td className={`${tdCls} text-right text-amber-400`}>{row.transfer_qty || "—"}</td>
                          <td className={`${tdCls} text-right text-zinc-200`}>{currency(row.gross_sales)}</td>
                          <td className={`${tdCls} text-right text-zinc-400`}>{currency(row.discounts)}</td>
                          <td className={`${tdCls} text-right font-medium text-zinc-100`}>{currency(row.net_sales)}</td>
                          <td className={`${tdCls} text-right text-zinc-400`}>{currency(row.tax)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-zinc-600 bg-zinc-800 font-semibold">
                        <td className={`${tdCls} text-zinc-200`} colSpan={groupBy === "beerSize" ? 2 : 1}>Totals</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{totals.sales_qty}</td>
                        <td className={`${tdCls} text-right text-amber-400`}>{totals.transfer_qty}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{currency(totals.gross)}</td>
                        <td className={`${tdCls} text-right text-zinc-400`}>{currency(totals.disc)}</td>
                        <td className={`${tdCls} text-right text-zinc-100`}>{currency(totals.net)}</td>
                        <td className={`${tdCls} text-right text-zinc-400`}>{currency(totals.tax)}</td>
                      </tr>
                    </tfoot>
                  </>
                ) : (
                  <>
                    <thead>
                      <tr className="border-b border-zinc-700 bg-zinc-800">
                        <SortTh label="Date"        col="date"        {...sp} />
                        <SortTh label="Time"        col="time"        {...sp} />
                        <SortTh label="Beer"        col="beer"        {...sp} />
                        <SortTh label="Size"        col="size"        {...sp} />
                        <SortTh label="Qty"         col="qty"         {...sp} align="right" />
                        <th className="px-4 py-3 font-medium text-zinc-300 text-left">Type</th>
                        <SortTh label="Gross Sales" col="gross_sales" {...sp} align="right" />
                        <SortTh label="Discounts"   col="discounts"   {...sp} align="right" />
                        <SortTh label="Net Sales"   col="net_sales"   {...sp} align="right" />
                        <SortTh label="Tax"         col="tax"         {...sp} align="right" />
                      </tr>
                    </thead>
                    <tbody className="bg-zinc-900">
                      {(rawSort.sorted ?? rows ?? []).map((row, i) => (
                        <tr key={i} className={`border-b border-zinc-800 hover:bg-zinc-800 ${row.is_transfer ? "bg-zinc-800/50" : ""}`}>
                          <td className={`${tdCls} text-zinc-200 whitespace-nowrap`}>{row.date}</td>
                          <td className={`${tdCls} text-zinc-400 whitespace-nowrap`}>{row.time}</td>
                          <td className={`${tdCls} font-medium text-zinc-100`}>{row.beer}</td>
                          <td className={`${tdCls} text-zinc-300`}>{row.size}</td>
                          <td className={`${tdCls} text-right text-zinc-200`}>{row.qty}</td>
                          <td className={tdCls}>
                            {row.is_transfer
                              ? <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-900 text-amber-300">Transfer</span>
                              : <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-900 text-green-300">Sale</span>}
                          </td>
                          <td className={`${tdCls} text-right text-zinc-200`}>{row.is_transfer ? "—" : currency(row.gross_sales)}</td>
                          <td className={`${tdCls} text-right text-zinc-400`}>{row.is_transfer ? "—" : currency(row.discounts)}</td>
                          <td className={`${tdCls} text-right font-medium text-zinc-100`}>{row.is_transfer ? "—" : currency(row.net_sales)}</td>
                          <td className={`${tdCls} text-right text-zinc-400`}>{row.is_transfer ? "—" : currency(row.tax)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-zinc-600 bg-zinc-800 font-semibold">
                        <td className={tdCls} colSpan={4}><span className="text-zinc-300">Totals (Sales only)</span></td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{totals.sales_qty}</td>
                        <td className={tdCls} />
                        <td className={`${tdCls} text-right text-zinc-200`}>{currency(totals.gross)}</td>
                        <td className={`${tdCls} text-right text-zinc-400`}>{currency(totals.disc)}</td>
                        <td className={`${tdCls} text-right text-zinc-100`}>{currency(totals.net)}</td>
                        <td className={`${tdCls} text-right text-zinc-400`}>{currency(totals.tax)}</td>
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
