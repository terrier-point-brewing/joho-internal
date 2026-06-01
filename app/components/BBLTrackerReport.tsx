"use client";

import { useState } from "react";
import ReportControls from "./ReportControls";

type StyleRow = {
  style: string;
  taproom_draft_bbl: string; taproom_pkg_bbl: string;
  dist_bbl: string; contract_bbl: string;
  half_keg_count: number; quarter_keg_count: number; sixth_keg_count: number;
  total_cans: number; total_bbl: string; total_gallons: string; excise_tax: string;
};
type ChannelRow = { channel: string; bbl: string; gallons: string };

function bbl(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return n.toFixed(3);
}
function gal(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return n.toFixed(2);
}
function currency(v: string | number) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function today() { return new Date().toISOString().slice(0, 10); }
function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

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

const thCls = "px-4 py-3 font-medium text-zinc-300";
const tdCls = "px-4 py-2";

export default function BBLTrackerReport() {
  const [start, setStart]           = useState(firstOfMonth());
  const [end, setEnd]               = useState(today());
  const [styleRows, setStyleRows]   = useState<StyleRow[] | null>(null);
  const [channelRows, setChannelRows] = useState<ChannelRow[] | null>(null);
  const [exciseTax, setExciseTax]   = useState<string | null>(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);

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
        start={start} end={end} onStartChange={setStart} onEndChange={setEnd}
        onRun={runReport} loading={loading} hasData={hasData}
        onExport={() => styleRows && channelRows && exciseTax && exportCSV(styleRows, channelRows, exciseTax)}
        groupBy="none" groupOptions={[]} onGroupByChange={() => {}}
      />

      {error && <div className="mt-4 p-3 bg-red-950 border border-red-700 rounded-md text-sm text-red-300">{error}</div>}

      {styleRows !== null && (
        <div className="mt-4 space-y-6">

          {/* By Beer Style */}
          <div>
            <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">By Beer Style</h3>
            {styleRows.length === 0 ? (
              <p className="text-sm text-zinc-500">No production data found for this period.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-zinc-700">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-700 bg-zinc-800">
                      <th className={`${thCls} text-left`}>Style</th>
                      <th className={`${thCls} text-right`}>Draft (BBL)</th>
                      <th className={`${thCls} text-right`}>Taproom Pkg (BBL)</th>
                      <th className={`${thCls} text-right`}>Distrib (BBL)</th>
                      <th className={`${thCls} text-right`}>Contract (BBL)</th>
                      <th className={`${thCls} text-right`}>½ Kegs</th>
                      {showQuarter && <th className={`${thCls} text-right`}>¼ Kegs</th>}
                      <th className={`${thCls} text-right`}>⅙ Kegs</th>
                      <th className={`${thCls} text-right`}>Cans</th>
                      <th className={`${thCls} text-right`}>Total BBL</th>
                      <th className={`${thCls} text-right`}>Gallons</th>
                      <th className={`${thCls} text-right`}>Excise Tax</th>
                    </tr>
                  </thead>
                  <tbody className="bg-zinc-900">
                    {styleRows.map((row, i) => (
                      <tr key={i} className="border-b border-zinc-800 hover:bg-zinc-800">
                        <td className={`${tdCls} font-medium text-zinc-100`}>{row.style}</td>
                        <td className={`${tdCls} text-right ${parseFloat(row.taproom_draft_bbl) > 0 ? "text-zinc-200" : "text-zinc-600"}`}>
                          {parseFloat(row.taproom_draft_bbl) > 0 ? bbl(row.taproom_draft_bbl) : "—"}
                        </td>
                        <td className={`${tdCls} text-right ${parseFloat(row.taproom_pkg_bbl) > 0 ? "text-zinc-200" : "text-zinc-600"}`}>
                          {parseFloat(row.taproom_pkg_bbl) > 0 ? bbl(row.taproom_pkg_bbl) : "—"}
                        </td>
                        <td className={`${tdCls} text-right ${parseFloat(row.dist_bbl) > 0 ? "text-blue-300" : "text-zinc-600"}`}>
                          {parseFloat(row.dist_bbl) > 0 ? bbl(row.dist_bbl) : "—"}
                        </td>
                        <td className={`${tdCls} text-right ${parseFloat(row.contract_bbl) > 0 ? "text-purple-300" : "text-zinc-600"}`}>
                          {parseFloat(row.contract_bbl) > 0 ? bbl(row.contract_bbl) : "—"}
                        </td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{row.half_keg_count   || "—"}</td>
                        {showQuarter && <td className={`${tdCls} text-right text-zinc-200`}>{row.quarter_keg_count || "—"}</td>}
                        <td className={`${tdCls} text-right text-zinc-200`}>{row.sixth_keg_count  || "—"}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{row.total_cans       || "—"}</td>
                        <td className={`${tdCls} text-right font-semibold text-zinc-100`}>{bbl(row.total_bbl)}</td>
                        <td className={`${tdCls} text-right text-zinc-300`}>{gal(row.total_gallons)}</td>
                        <td className={`${tdCls} text-right text-green-400`}>{currency(row.excise_tax)}</td>
                      </tr>
                    ))}
                  </tbody>
                  {styleTotals && (
                    <tfoot>
                      <tr className="border-t-2 border-zinc-600 bg-zinc-800 font-semibold">
                        <td className={`${tdCls} text-zinc-200`}>Total</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{bbl(styleTotals.taproomDraft)}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{bbl(styleTotals.taproomPkg)}</td>
                        <td className={`${tdCls} text-right text-blue-300`}>{bbl(styleTotals.dist)}</td>
                        <td className={`${tdCls} text-right text-purple-300`}>{bbl(styleTotals.contract)}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{styleTotals.halfKeg   || "—"}</td>
                        {showQuarter && <td className={`${tdCls} text-right text-zinc-200`}>{styleTotals.quarterKeg || "—"}</td>}
                        <td className={`${tdCls} text-right text-zinc-200`}>{styleTotals.sixthKeg  || "—"}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{styleTotals.cans      || "—"}</td>
                        <td className={`${tdCls} text-right text-zinc-100`}>{bbl(styleTotals.totalBBL)}</td>
                        <td className={`${tdCls} text-right text-zinc-300`}>{gal(styleTotals.totalGal)}</td>
                        <td className={`${tdCls} text-right text-green-400`}>{currency(exciseTax ?? 0)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </div>

          {/* By Channel */}
          {channelRows && channelRows.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">By Channel</h3>
              <div className="overflow-x-auto rounded-lg border border-zinc-700">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-700 bg-zinc-800">
                      <th className={`${thCls} text-left`}>Channel</th>
                      <th className={`${thCls} text-right`}>BBL</th>
                      <th className={`${thCls} text-right`}>Gallons</th>
                    </tr>
                  </thead>
                  <tbody className="bg-zinc-900">
                    {channelRows.map((row, i) => (
                      <tr key={i} className="border-b border-zinc-800 hover:bg-zinc-800">
                        <td className={`${tdCls} font-medium text-zinc-100`}>{row.channel}</td>
                        <td className={`${tdCls} text-right text-zinc-200`}>{bbl(row.bbl)}</td>
                        <td className={`${tdCls} text-right text-zinc-300`}>{gal(row.gallons)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-zinc-600 bg-zinc-800 font-semibold">
                      <td className={`${tdCls} text-zinc-200`}>Total</td>
                      <td className={`${tdCls} text-right text-zinc-100`}>{bbl(channelRows.reduce((s, r) => s + parseFloat(r.bbl), 0))}</td>
                      <td className={`${tdCls} text-right text-zinc-300`}>{gal(channelRows.reduce((s, r) => s + parseFloat(r.gallons), 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* Excise Tax */}
          {exciseTax !== null && (
            <div className="inline-flex items-center gap-3 px-4 py-3 bg-zinc-900 border border-zinc-700 rounded-lg">
              <span className="text-sm font-medium text-zinc-300">Total Excise Tax Due</span>
              <span className="text-lg font-semibold text-green-400">{currency(exciseTax)}</span>
              <span className="text-xs text-zinc-500">(NC $0.6171/gal + Federal $3.50/BBL)</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
