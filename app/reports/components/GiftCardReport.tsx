"use client";

import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import ReportControls from "./ReportControls";
import ReportTable, { tdCls, numCls, currency, THEAD_ROW, TBODY, TR, TFOOT_ROW } from "./ReportTable";
import { useSort, SortTh } from "./SortControls";

type Row = {
  date: string; time: string; name: string; qty: number;
  face_value: string; gross_sales: string; discounts: string;
  discount_names: string[]; net_sales: string; tax: string; order_id: string;
};

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

interface Props { start: string; end: string; onStartChange: (v: string) => void; onEndChange: (v: string) => void; }

export default function GiftCardReport({ start, end, onStartChange, onEndChange }: Props) {
  const [rows, setRows]   = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const { sorted, sortKey, sortDir, handleSort } = useSort(rows);

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

  const sp = { sortKey, sortDir, onSort: handleSort };

  return (
    <div>
      <ReportControls
        start={start} end={end} onStartChange={onStartChange} onEndChange={onEndChange}
        onRun={runReport} loading={loading} hasData={!!rows?.length}
        onExport={() => rows && exportCSV(rows)}
        groupBy="none" groupOptions={[]} onGroupByChange={() => {}}
      />

      {error && <Banner className="mt-4">{error}</Banner>}

      {rows !== null && (
        <div className="mt-4">
          <p className="text-sm text-secondary mb-3">
            {rows.length === 0
              ? "No gift card sales found for this period."
              : `${rows.length} transaction${rows.length !== 1 ? "s" : ""}`}
          </p>
          {rows.length > 0 && (
            <ReportTable>
                <thead>
                  <tr className={THEAD_ROW}>
                    <SortTh label="Date"          col="date"        {...sp} />
                    <SortTh label="Time"          col="time"        {...sp} />
                    <SortTh label="Name"          col="name"        {...sp} />
                    <SortTh label="Qty"           col="qty"         {...sp} align="right" />
                    <SortTh label="Face Value"    col="face_value"  {...sp} align="right" />
                    <SortTh label="Gross Sales"   col="gross_sales" {...sp} align="right" />
                    <SortTh label="Discounts"     col="discounts"   {...sp} align="right" />
                    <th className="px-4 py-3 font-medium text-body text-left">Discount Notes</th>
                    <SortTh label="Net Sales"     col="net_sales"   {...sp} align="right" />
                    <SortTh label="Tax"           col="tax"         {...sp} align="right" />
                  </tr>
                </thead>
                <tbody className={TBODY}>
                  {(sorted ?? []).map((row, i) => {
                    const isComped = parseFloat(row.net_sales) === 0;
                    return (
                      <tr key={i} className={TR}>
                        <td className={`${tdCls} text-strong whitespace-nowrap`}>{row.date}</td>
                        <td className={`${tdCls} text-secondary whitespace-nowrap`}>{row.time}</td>
                        <td className={`${tdCls} font-medium text-primary`}>{row.name}</td>
                        <td className={`${numCls} text-strong`}>{row.qty}</td>
                        <td className={`${numCls} text-strong`}>{currency(row.face_value)}</td>
                        <td className={`${numCls} text-strong`}>{currency(row.gross_sales)}</td>
                        <td className={`${numCls} ${parseFloat(row.discounts) > 0 ? "text-accent" : "text-faint"}`}>
                          {parseFloat(row.discounts) > 0 ? currency(row.discounts) : "—"}
                        </td>
                        <td className={`${tdCls} text-secondary text-xs`}>
                          {row.discount_names.length > 0 ? row.discount_names.join(", ") : "—"}
                        </td>
                        <td className={`${numCls} font-medium ${isComped ? "text-muted" : "text-primary"}`}>
                          {currency(row.net_sales)}
                        </td>
                        <td className={`${numCls} text-secondary`}>
                          {parseFloat(row.tax) > 0 ? currency(row.tax) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className={TFOOT_ROW}>
                    <td className={tdCls} colSpan={3}><span className="text-strong">Totals</span></td>
                    <td className={`${numCls} text-strong`}>{totals!.qty}</td>
                    <td className={`${numCls} text-strong`}>{currency(totals!.face)}</td>
                    <td className={`${numCls} text-strong`}>{currency(totals!.gross)}</td>
                    <td className={`${numCls} text-accent`}>{currency(totals!.disc)}</td>
                    <td className={tdCls} />
                    <td className={`${numCls} text-primary`}>{currency(totals!.net)}</td>
                    <td className={`${numCls} text-secondary`}>{currency(totals!.tax)}</td>
                  </tr>
                </tfoot>
            </ReportTable>
          )}
        </div>
      )}
    </div>
  );
}
