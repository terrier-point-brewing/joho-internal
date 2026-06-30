"use client";

import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import ReportControls from "./ReportControls";
import ReportTable, { tdCls, numCls, currency, THEAD_ROW, TBODY, TR, TFOOT_ROW } from "./ReportTable";
import { BBL_CHANNEL_TEXT } from "./categoryStyles";
import { useSort, SortTh } from "./SortControls";

type StyleRow = {
  style: string;
  taproom_draft_bbl: string; taproom_pkg_bbl: string;
  dist_bbl: string; contract_bbl: string;
  half_keg_count: number; quarter_keg_count: number; sixth_keg_count: number;
  total_cans: number; total_bbl: string; total_gallons: string; excise_tax: string;
};
type ChannelRow = { channel: string; bbl: string; gallons: string };

function bbl(v: string | number) { return (typeof v === "string" ? parseFloat(v) : v).toFixed(3); }
function gal(v: string | number) { return (typeof v === "string" ? parseFloat(v) : v).toFixed(2); }

function exportCSV(styleRows: StyleRow[], channelRows: ChannelRow[], excise: string) {
  const lines = [
    "--- By Beer Style ---",
    "Style,Taproom Draft (BBL),Taproom Packaged (BBL),Distribution (BBL),Contract (BBL),1/2 Kegs,1/4 Kegs,1/6 Kegs,Cans,Total BBL,Gallons,Excise Tax",
    ...styleRows.map(r =>
      `"${r.style}",${r.taproom_draft_bbl},${r.taproom_pkg_bbl},${r.dist_bbl},${r.contract_bbl},${r.half_keg_count},${r.quarter_keg_count},${r.sixth_keg_count},${r.total_cans},${r.total_bbl},${r.total_gallons},${r.excise_tax}`
    ),
    "",
    "--- By Channel ---",
    "Channel,BBL,Gallons",
    ...channelRows.map(r => `"${r.channel}",${r.bbl},${r.gallons}`),
    "",
    `Total Excise Tax,${excise}`,
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "bbl-tracker.csv"; a.click();
  URL.revokeObjectURL(url);
}

interface Props { start: string; end: string; onStartChange: (v: string) => void; onEndChange: (v: string) => void; }

export default function BBLTrackerReport({ start, end, onStartChange, onEndChange }: Props) {
  const [styleRows, setStyleRows]     = useState<StyleRow[] | null>(null);
  const [channelRows, setChannelRows] = useState<ChannelRow[] | null>(null);
  const [exciseTax, setExciseTax]     = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);

  const styleSort   = useSort(styleRows);
  const channelSort = useSort(channelRows);
  const styleSp   = { sortKey: styleSort.sortKey,   sortDir: styleSort.sortDir,   onSort: styleSort.handleSort };
  const channelSp = { sortKey: channelSort.sortKey, sortDir: channelSort.sortDir, onSort: channelSort.handleSort };

  async function runReport() {
    setLoading(true); setError(null); setStyleRows(null); setChannelRows(null); setExciseTax(null);
    try {
      const res  = await fetch(`/api/bbl-tracker?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setStyleRows(data.by_style);
      setChannelRows(data.by_channel);
      setExciseTax(data.total_excise_tax);
    } catch (e) { setError(e instanceof Error ? e.message : "Unknown error"); }
    finally { setLoading(false); }
  }

  const hasData = !!styleRows?.length;

  const styleTotals = styleRows ? {
    taproomDraft: styleRows.reduce((s, r) => s + parseFloat(r.taproom_draft_bbl), 0),
    taproomPkg:   styleRows.reduce((s, r) => s + parseFloat(r.taproom_pkg_bbl), 0),
    dist:         styleRows.reduce((s, r) => s + parseFloat(r.dist_bbl), 0),
    contract:     styleRows.reduce((s, r) => s + parseFloat(r.contract_bbl), 0),
    halfKeg:      styleRows.reduce((s, r) => s + r.half_keg_count, 0),
    quarterKeg:   styleRows.reduce((s, r) => s + r.quarter_keg_count, 0),
    sixthKeg:     styleRows.reduce((s, r) => s + r.sixth_keg_count, 0),
    cans:         styleRows.reduce((s, r) => s + r.total_cans, 0),
    totalBBL:     styleRows.reduce((s, r) => s + parseFloat(r.total_bbl), 0),
    totalGal:     styleRows.reduce((s, r) => s + parseFloat(r.total_gallons), 0),
  } : null;

  const showQuarter = styleRows?.some(r => r.quarter_keg_count > 0);

  return (
    <div>
      <ReportControls
        start={start} end={end} onStartChange={onStartChange} onEndChange={onEndChange}
        onRun={runReport} loading={loading} hasData={hasData}
        onExport={() => styleRows && channelRows && exciseTax && exportCSV(styleRows, channelRows, exciseTax)}
        groupBy="none" groupOptions={[]} onGroupByChange={() => {}}
      />

      {error && <Banner className="mt-4">{error}</Banner>}

      {styleRows !== null && (
        <div className="mt-4 space-y-6">

          {/* By Beer Style */}
          <div>
            <h3 className="text-sm font-semibold text-secondary uppercase tracking-wider mb-2">By Beer Style</h3>
            {styleRows.length === 0 ? (
              <p className="text-sm text-muted">No production data found for this period.</p>
            ) : (
              <ReportTable>
                  <thead>
                    <tr className={THEAD_ROW}>
                      <SortTh label="Style"           col="style"              {...styleSp} />
                      <SortTh label="Draft (BBL)"     col="taproom_draft_bbl"  {...styleSp} align="right" />
                      <SortTh label="Taproom Pkg"     col="taproom_pkg_bbl"    {...styleSp} align="right" />
                      <SortTh label="Distrib (BBL)"   col="dist_bbl"           {...styleSp} align="right" />
                      <SortTh label="Contract (BBL)"  col="contract_bbl"       {...styleSp} align="right" />
                      <SortTh label="½ Kegs"          col="half_keg_count"     {...styleSp} align="right" />
                      {showQuarter && <SortTh label="¼ Kegs" col="quarter_keg_count" {...styleSp} align="right" />}
                      <SortTh label="⅙ Kegs"          col="sixth_keg_count"    {...styleSp} align="right" />
                      <SortTh label="Cans"            col="total_cans"         {...styleSp} align="right" />
                      <SortTh label="Total BBL"       col="total_bbl"          {...styleSp} align="right" />
                      <SortTh label="Gallons"         col="total_gallons"      {...styleSp} align="right" />
                      <SortTh label="Excise Tax"      col="excise_tax"         {...styleSp} align="right" />
                    </tr>
                  </thead>
                  <tbody className={TBODY}>
                    {(styleSort.sorted ?? []).map((row, i) => (
                      <tr key={i} className={TR}>
                        <td className={`${tdCls} font-medium text-primary`}>{row.style}</td>
                        <td className={`${numCls} ${parseFloat(row.taproom_draft_bbl) > 0 ? "text-strong" : "text-faint"}`}>
                          {parseFloat(row.taproom_draft_bbl) > 0 ? bbl(row.taproom_draft_bbl) : "—"}
                        </td>
                        <td className={`${numCls} ${parseFloat(row.taproom_pkg_bbl) > 0 ? "text-strong" : "text-faint"}`}>
                          {parseFloat(row.taproom_pkg_bbl) > 0 ? bbl(row.taproom_pkg_bbl) : "—"}
                        </td>
                        <td className={`${numCls} ${parseFloat(row.dist_bbl) > 0 ? BBL_CHANNEL_TEXT.dist.on : BBL_CHANNEL_TEXT.dist.off}`}>
                          {parseFloat(row.dist_bbl) > 0 ? bbl(row.dist_bbl) : "—"}
                        </td>
                        <td className={`${numCls} ${parseFloat(row.contract_bbl) > 0 ? BBL_CHANNEL_TEXT.contract.on : BBL_CHANNEL_TEXT.contract.off}`}>
                          {parseFloat(row.contract_bbl) > 0 ? bbl(row.contract_bbl) : "—"}
                        </td>
                        <td className={`${numCls} text-strong`}>{row.half_keg_count   || "—"}</td>
                        {showQuarter && <td className={`${numCls} text-strong`}>{row.quarter_keg_count || "—"}</td>}
                        <td className={`${numCls} text-strong`}>{row.sixth_keg_count  || "—"}</td>
                        <td className={`${numCls} text-strong`}>{row.total_cans       || "—"}</td>
                        <td className={`${numCls} font-semibold text-primary`}>{bbl(row.total_bbl)}</td>
                        <td className={`${numCls} text-body`}>{gal(row.total_gallons)}</td>
                        <td className={`${numCls} text-success`}>{currency(row.excise_tax)}</td>
                      </tr>
                    ))}
                  </tbody>
                  {styleTotals && (
                    <tfoot>
                      <tr className={TFOOT_ROW}>
                        <td className={`${tdCls} text-strong`}>Total</td>
                        <td className={`${numCls} text-strong`}>{bbl(styleTotals.taproomDraft)}</td>
                        <td className={`${numCls} text-strong`}>{bbl(styleTotals.taproomPkg)}</td>
                        <td className={`${numCls} ${BBL_CHANNEL_TEXT.dist.on}`}>{bbl(styleTotals.dist)}</td>
                        <td className={`${numCls} ${BBL_CHANNEL_TEXT.contract.on}`}>{bbl(styleTotals.contract)}</td>
                        <td className={`${numCls} text-strong`}>{styleTotals.halfKeg   || "—"}</td>
                        {showQuarter && <td className={`${numCls} text-strong`}>{styleTotals.quarterKeg || "—"}</td>}
                        <td className={`${numCls} text-strong`}>{styleTotals.sixthKeg  || "—"}</td>
                        <td className={`${numCls} text-strong`}>{styleTotals.cans      || "—"}</td>
                        <td className={`${numCls} text-primary`}>{bbl(styleTotals.totalBBL)}</td>
                        <td className={`${numCls} text-body`}>{gal(styleTotals.totalGal)}</td>
                        <td className={`${numCls} text-success`}>{currency(exciseTax ?? 0)}</td>
                      </tr>
                    </tfoot>
                  )}
              </ReportTable>
            )}
          </div>

          {/* By Channel */}
          {channelRows && channelRows.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-secondary uppercase tracking-wider mb-2">By Channel</h3>
              <ReportTable>
                  <thead>
                    <tr className={THEAD_ROW}>
                      <SortTh label="Channel" col="channel" {...channelSp} />
                      <SortTh label="BBL"     col="bbl"     {...channelSp} align="right" />
                      <SortTh label="Gallons" col="gallons" {...channelSp} align="right" />
                    </tr>
                  </thead>
                  <tbody className={TBODY}>
                    {(channelSort.sorted ?? []).map((row, i) => (
                      <tr key={i} className={TR}>
                        <td className={`${tdCls} font-medium text-primary`}>{row.channel}</td>
                        <td className={`${numCls} text-strong`}>{bbl(row.bbl)}</td>
                        <td className={`${numCls} text-body`}>{gal(row.gallons)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className={TFOOT_ROW}>
                      <td className={`${tdCls} text-strong`}>Total</td>
                      <td className={`${numCls} text-primary`}>{bbl(channelRows.reduce((s, r) => s + parseFloat(r.bbl), 0))}</td>
                      <td className={`${numCls} text-body`}>{gal(channelRows.reduce((s, r) => s + parseFloat(r.gallons), 0))}</td>
                    </tr>
                  </tfoot>
              </ReportTable>
            </div>
          )}

          {exciseTax !== null && (
            <Card padding="px-4 py-3" className="inline-flex items-center gap-3">
              <span className="text-sm font-medium text-body">Total Excise Tax Due</span>
              <span className="text-base sm:text-xl font-semibold text-success">{currency(exciseTax)}</span>
              <span className="text-xs text-muted">(NC $0.6171/gal + Federal $3.50/BBL)</span>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
