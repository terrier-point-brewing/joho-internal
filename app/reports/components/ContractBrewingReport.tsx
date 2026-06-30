"use client";

import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import ReportControls from "./ReportControls";
import ReportTable, { tdCls, numCls, currency, THEAD_ROW, TBODY, TR, TFOOT_ROW } from "./ReportTable";
import { useSort, SortTh } from "./SortControls";

type CategoryRow = { category: string; gross_sales: string; discounts: string; net_sales: string };
type CustomerRow  = { customer: string; invoices: number; total_charged: string; total_outstanding: string };

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

      {error && <Banner className="mt-4">{error}</Banner>}

      {catRows !== null && (
        <div className="mt-4 space-y-6">

          {/* Revenue by Category */}
          <div>
            <h3 className="text-sm font-semibold text-secondary uppercase tracking-wider mb-2">Revenue by Category</h3>
            <ReportTable>
                <thead>
                  <tr className={THEAD_ROW}>
                    <SortTh label="Category"      col="category"   {...catSp} />
                    <SortTh label="Gross Revenue" col="gross_sales" {...catSp} align="right" />
                    <SortTh label="Net Revenue"   col="net_sales"   {...catSp} align="right" />
                  </tr>
                </thead>
                <tbody className={TBODY}>
                  {(catSort.sorted ?? []).map((row, i) => (
                    <tr key={i} className={TR}>
                      <td className={`${tdCls} font-medium text-primary`}>{row.category}</td>
                      <td className={`${numCls} text-strong`}>{currency(row.gross_sales)}</td>
                      <td className={`${numCls} font-medium text-primary`}>{currency(row.net_sales)}</td>
                    </tr>
                  ))}
                </tbody>
                {catTotals && (
                  <tfoot>
                    <tr className={TFOOT_ROW}>
                      <td className={`${tdCls} text-strong`}>Total</td>
                      <td className={`${numCls} text-strong`}>{currency(catTotals.gross)}</td>
                      <td className={`${numCls} text-primary`}>{currency(catTotals.net)}</td>
                    </tr>
                  </tfoot>
                )}
            </ReportTable>
            {catTotals && catTotals.disc > 0 && (
              <Card padding="px-4 py-3" className="mt-3 inline-flex items-center gap-3">
                <span className="text-sm font-medium text-body">Total Discounts Applied</span>
                <span className="text-base sm:text-xl font-semibold text-accent">{currency(catTotals.disc)}</span>
              </Card>
            )}
          </div>

          {/* By Customer */}
          {custRows && custRows.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-secondary uppercase tracking-wider mb-2">By Customer</h3>
              <ReportTable>
                  <thead>
                    <tr className={THEAD_ROW}>
                      <SortTh label="Customer"    col="customer"          {...custSp} />
                      <SortTh label="Invoices"    col="invoices"          {...custSp} align="right" />
                      <SortTh label="Total Charged"    col="total_charged"     {...custSp} align="right" />
                      <SortTh label="Outstanding" col="total_outstanding" {...custSp} align="right" />
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
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className={TFOOT_ROW}>
                      <td className={`${tdCls} text-strong`}>Total</td>
                      <td className={`${numCls} text-strong`}>{custRows.reduce((s, r) => s + r.invoices, 0)}</td>
                      <td className={`${numCls} text-strong`}>{currency(custRows.reduce((s, r) => s + parseFloat(r.total_charged), 0))}</td>
                      <td className={`${numCls} text-accent`}>{currency(custRows.reduce((s, r) => s + parseFloat(r.total_outstanding), 0))}</td>
                    </tr>
                  </tfoot>
              </ReportTable>
            </div>
          )}

          {catRows.every(r => parseFloat(r.gross_sales) === 0) && (
            <p className="text-sm text-muted">No contract brewing invoices found for this period.</p>
          )}
        </div>
      )}
    </div>
  );
}
