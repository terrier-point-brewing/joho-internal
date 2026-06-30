"use client";

import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import ReportControls from "./ReportControls";
import ReportTable, { tdCls, numCls, currency, THEAD_ROW, TBODY, TR, TFOOT_ROW } from "./ReportTable";
import { useSort, SortTh } from "./SortControls";

type SizeRow     = { size: string; qty: number; gross_sales: string; discounts: string; net_sales: string };
type CustomerRow = {
  customer: string; invoices: number;
  total_charged: string; total_outstanding: string;
  half_keg_qty: number; sixth_keg_qty: number; quarter_keg_qty: number; cans_qty: number;
};

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

interface Props { start: string; end: string; onStartChange: (v: string) => void; onEndChange: (v: string) => void; }

export default function DistributionReport({ start, end, onStartChange, onEndChange }: Props) {
  const [sizeRows, setSizeRows]   = useState<SizeRow[] | null>(null);
  const [custRows, setCustRows]   = useState<CustomerRow[] | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const sizeSort = useSort(sizeRows);
  const custSort = useSort(custRows);
  const sizeSp = { sortKey: sizeSort.sortKey, sortDir: sizeSort.sortDir, onSort: sizeSort.handleSort };
  const custSp = { sortKey: custSort.sortKey, sortDir: custSort.sortDir, onSort: custSort.handleSort };

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
        start={start} end={end} onStartChange={onStartChange} onEndChange={onEndChange}
        onRun={runReport} loading={loading} hasData={hasData}
        onExport={() => sizeRows && custRows && exportCSV(sizeRows, custRows)}
        groupBy="none" groupOptions={[]} onGroupByChange={() => {}}
      />

      {error && <Banner className="mt-4">{error}</Banner>}

      {sizeRows !== null && (
        <div className="mt-4 space-y-6">

          {/* Revenue by Size */}
          <div>
            <h3 className="text-sm font-semibold text-secondary uppercase tracking-wider mb-2">Revenue by Size</h3>
            {sizeRows.length === 0 ? (
              <p className="text-sm text-muted">No distribution invoices found for this period.</p>
            ) : (
              <ReportTable>
                  <thead>
                    <tr className={THEAD_ROW}>
                      <SortTh label="Size"       col="size"       {...sizeSp} />
                      <SortTh label="Qty"        col="qty"        {...sizeSp} align="right" />
                      <SortTh label="Gross Sales" col="gross_sales" {...sizeSp} align="right" />
                      <SortTh label="Discounts"  col="discounts"  {...sizeSp} align="right" />
                      <SortTh label="Net Sales"  col="net_sales"  {...sizeSp} align="right" />
                    </tr>
                  </thead>
                  <tbody className={TBODY}>
                    {(sizeSort.sorted ?? []).map((row, i) => (
                      <tr key={i} className={TR}>
                        <td className={`${tdCls} font-medium text-primary`}>{row.size}</td>
                        <td className={`${numCls} text-strong`}>{row.qty}</td>
                        <td className={`${numCls} text-strong`}>{currency(row.gross_sales)}</td>
                        <td className={`${numCls} ${parseFloat(row.discounts) > 0 ? "text-accent" : "text-faint"}`}>
                          {parseFloat(row.discounts) > 0 ? currency(row.discounts) : "—"}
                        </td>
                        <td className={`${numCls} font-medium text-primary`}>{currency(row.net_sales)}</td>
                      </tr>
                    ))}
                  </tbody>
                  {sizeTotals && (
                    <tfoot>
                      <tr className={TFOOT_ROW}>
                        <td className={`${tdCls} text-strong`}>Total</td>
                        <td className={`${numCls} text-strong`}>{sizeTotals.qty}</td>
                        <td className={`${numCls} text-strong`}>{currency(sizeTotals.gross)}</td>
                        <td className={`${numCls} text-accent`}>{sizeTotals.disc > 0 ? currency(sizeTotals.disc) : "—"}</td>
                        <td className={`${numCls} text-primary`}>{currency(sizeTotals.net)}</td>
                      </tr>
                    </tfoot>
                  )}
              </ReportTable>
            )}
          </div>

          {/* By Customer */}
          {custRows && custRows.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-secondary uppercase tracking-wider mb-2">By Customer</h3>
              <ReportTable>
                  <thead>
                    <tr className={THEAD_ROW}>
                      <SortTh label="Customer"     col="customer"          {...custSp} />
                      <SortTh label="Invoices"     col="invoices"          {...custSp} align="right" />
                      <SortTh label="Total Charged" col="total_charged"     {...custSp} align="right" />
                      <SortTh label="Outstanding"  col="total_outstanding" {...custSp} align="right" />
                      <SortTh label="½ Kegs"       col="half_keg_qty"      {...custSp} align="right" />
                      <SortTh label="⅙ Kegs"       col="sixth_keg_qty"     {...custSp} align="right" />
                      <SortTh label="¼ Kegs"       col="quarter_keg_qty"   {...custSp} align="right" />
                      <SortTh label="Cans"         col="cans_qty"          {...custSp} align="right" />
                    </tr>
                  </thead>
                  <tbody className={TBODY}>
                    {(custSort.sorted ?? []).map((row, i) => (
                      <tr key={i} className={TR}>
                        <td className={`${tdCls} font-medium text-primary`}>{row.customer}</td>
                        <td className={`${numCls} text-strong`}>{row.invoices}</td>
                        <td className={`${numCls} text-strong`}>{currency(row.total_charged)}</td>
                        <td className={`${numCls} font-medium ${parseFloat(row.total_outstanding) > 0 ? "text-accent" : "text-muted"}`}>
                          {parseFloat(row.total_outstanding) > 0 ? currency(row.total_outstanding) : "—"}
                        </td>
                        <td className={`${numCls} text-strong`}>{row.half_keg_qty    || "—"}</td>
                        <td className={`${numCls} text-strong`}>{row.sixth_keg_qty   || "—"}</td>
                        <td className={`${numCls} text-strong`}>{row.quarter_keg_qty || "—"}</td>
                        <td className={`${numCls} text-strong`}>{row.cans_qty        || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className={TFOOT_ROW}>
                      <td className={`${tdCls} text-strong`}>Total</td>
                      <td className={`${numCls} text-strong`}>{custRows.reduce((s, r) => s + r.invoices, 0)}</td>
                      <td className={`${numCls} text-strong`}>{currency(custRows.reduce((s, r) => s + parseFloat(r.total_charged), 0))}</td>
                      <td className={`${numCls} text-accent`}>{currency(custRows.reduce((s, r) => s + parseFloat(r.total_outstanding), 0))}</td>
                      <td className={`${numCls} text-strong`}>{custRows.reduce((s, r) => s + r.half_keg_qty, 0) || "—"}</td>
                      <td className={`${numCls} text-strong`}>{custRows.reduce((s, r) => s + r.sixth_keg_qty, 0) || "—"}</td>
                      <td className={`${numCls} text-strong`}>{custRows.reduce((s, r) => s + r.quarter_keg_qty, 0) || "—"}</td>
                      <td className={`${numCls} text-strong`}>{custRows.reduce((s, r) => s + r.cans_qty, 0) || "—"}</td>
                    </tr>
                  </tfoot>
              </ReportTable>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
