"use client";

import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import ReportControls from "./ReportControls";
import ReportTable, { tdCls, numCls, currency, THEAD_ROW, TBODY, TR, TFOOT_ROW } from "./ReportTable";
import { useSort, SortTh } from "./SortControls";

type CategoryRow = {
  category: string;
  gross_sales: string;
  discounts: string;
  returns: string;
  net_sales: string;
  tax: string;
};

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

const EXCLUDED_FROM_ATTRIBUTED = new Set(["CO2", "Other"]);

interface Props { start: string; end: string; onStartChange: (v: string) => void; onEndChange: (v: string) => void; }

export default function TaproomModelReport({ start, end, onStartChange, onEndChange }: Props) {
  const [rows, setRows]       = useState<CategoryRow[] | null>(null);
  const [tips, setTips]       = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const { sorted, sortKey, sortDir, handleSort } = useSort(rows);

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
  const attributedNetSales = rows
    ? rows.filter((r) => !EXCLUDED_FROM_ATTRIBUTED.has(r.category))
          .reduce((s, r) => s + parseFloat(r.net_sales), 0)
    : null;
  const grandTotals = rows ? {
    gross:     rows.reduce((s, r) => s + parseFloat(r.gross_sales), 0),
    discounts: rows.reduce((s, r) => s + parseFloat(r.discounts),   0),
    returns:   rows.reduce((s, r) => s + parseFloat(r.returns),     0),
    net:       rows.reduce((s, r) => s + parseFloat(r.net_sales),   0),
    tax:       rows.reduce((s, r) => s + parseFloat(r.tax),         0),
  } : null;

  const sp = { sortKey, sortDir, onSort: handleSort };

  return (
    <div>
      <ReportControls
        start={start} end={end} onStartChange={onStartChange} onEndChange={onEndChange}
        onRun={runReport} loading={loading} hasData={hasData}
        onExport={() => rows && tips !== null && exportCSV(rows, tips)}
        groupBy="none" groupOptions={[]} onGroupByChange={() => {}}
      />

      {error && <Banner className="mt-4">{error}</Banner>}

      {rows !== null && (
        <div className="mt-4 space-y-4">
          <ReportTable>
              <thead>
                <tr className={THEAD_ROW}>
                  <SortTh label="Category"      col="category"   {...sp} />
                  <SortTh label="Gross Sales"   col="gross_sales" {...sp} align="right" />
                  <SortTh label="Discounts"     col="discounts"   {...sp} align="right" />
                  <SortTh label="Returns"       col="returns"     {...sp} align="right" />
                  <SortTh label="Net Sales"     col="net_sales"   {...sp} align="right" />
                  <SortTh label="Tax Collected" col="tax"         {...sp} align="right" />
                </tr>
              </thead>
              <tbody className={TBODY}>
                {(sorted ?? []).map((row, i) => {
                  const isZero = parseFloat(row.gross_sales) === 0 && parseFloat(row.net_sales) === 0;
                  return (
                    <tr key={i} className={TR}>
                      <td className={`${tdCls} font-medium ${isZero ? "text-faint" : "text-primary"}`}>{row.category}</td>
                      <td className={`${numCls} ${isZero ? "text-faint" : "text-strong"}`}>{currency(row.gross_sales)}</td>
                      <td className={`${numCls} ${isZero ? "text-faint" : "text-secondary"}`}>
                        {parseFloat(row.discounts) > 0 ? currency(row.discounts) : "—"}
                      </td>
                      <td className={`${numCls} ${parseFloat(row.returns) > 0 ? "text-danger" : "text-faint"}`}>
                        {parseFloat(row.returns) > 0 ? currency(row.returns) : "—"}
                      </td>
                      <td className={`${numCls} font-medium ${isZero ? "text-faint" : "text-primary"}`}>{currency(row.net_sales)}</td>
                      <td className={`${numCls} ${isZero ? "text-faint" : "text-secondary"}`}>
                        {parseFloat(row.tax) > 0 ? currency(row.tax) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {grandTotals && (
                <tfoot>
                  <tr className={TFOOT_ROW}>
                    <td className={`${tdCls} text-strong`}>Total</td>
                    <td className={`${numCls} text-strong`}>{currency(grandTotals.gross)}</td>
                    <td className={`${numCls} text-secondary`}>{currency(grandTotals.discounts)}</td>
                    <td className={`${numCls} ${grandTotals.returns > 0 ? "text-danger" : "text-faint"}`}>
                      {grandTotals.returns > 0 ? currency(grandTotals.returns) : "—"}
                    </td>
                    <td className={`${numCls} text-primary`}>{currency(grandTotals.net)}</td>
                    <td className={`${numCls} text-secondary`}>{currency(grandTotals.tax)}</td>
                  </tr>
                </tfoot>
              )}
          </ReportTable>

          <div className="flex flex-wrap gap-3">
            {attributedNetSales !== null && (
              <Card padding="px-4 py-3" className="inline-flex items-center gap-3">
                <span className="text-sm font-medium text-body">Taproom Attributed Net Sales</span>
                <span className="text-base sm:text-xl font-semibold text-primary">{currency(attributedNetSales)}</span>
              </Card>
            )}
            {tips !== null && (
              <Card padding="px-4 py-3" className="inline-flex items-center gap-3">
                <span className="text-sm font-medium text-body">Total Tips Collected</span>
                <span className="text-base sm:text-xl font-semibold text-primary">{currency(tips)}</span>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
