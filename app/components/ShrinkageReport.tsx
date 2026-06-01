"use client";

import { useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from "recharts";
import ReportControls from "./ReportControls";

type CountEvent = {
  date: string; week: string; qty: string; shrinkage_pct: string | null;
};
type ItemRow = {
  item_name: string; variation_name: string;
  latest_qty: string; peak_qty: string;
  pct_remaining: string | null; avg_shrinkage_pct: string | null;
  counts: CountEvent[];
};
type ChartItem = { name: string; category: string };

// Colour palette for chart lines
const LINE_COLORS = [
  "#60a5fa", "#f59e0b", "#34d399", "#f87171", "#a78bfa",
  "#fb923c", "#38bdf8", "#4ade80", "#e879f9", "#facc15",
];

function today() { return new Date().toISOString().slice(0, 10); }
function ninetyDaysAgo() {
  const d = new Date(); d.setDate(d.getDate() - 90);
  return d.toISOString().slice(0, 10);
}

const thCls = "px-4 py-3 font-medium text-zinc-300";
const tdCls = "px-4 py-2";

function pctColor(pct: string | null) {
  if (pct === null) return "text-zinc-500";
  const n = parseFloat(pct);
  if (n >= 50) return "text-red-400";
  if (n >= 20) return "text-amber-400";
  return "text-green-400";
}

function ItemTable({ rows, title }: { rows: ItemRow[]; title: string }) {
  if (rows.length === 0) return (
    <div>
      <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">{title}</h3>
      <p className="text-sm text-zinc-500">No fl oz physical count data found for this period.</p>
    </div>
  );

  return (
    <div>
      <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">{title}</h3>
      <div className="overflow-x-auto rounded-lg border border-zinc-700">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-700 bg-zinc-800">
              <th className={`${thCls} text-left`}>Item</th>
              <th className={`${thCls} text-right`}>Peak (fl oz)</th>
              <th className={`${thCls} text-right`}>Latest (fl oz)</th>
              <th className={`${thCls} text-right`}>% Remaining</th>
              <th className={`${thCls} text-right`}>Avg Depletion %</th>
              <th className={`${thCls} text-left`}>Count History</th>
            </tr>
          </thead>
          <tbody className="bg-zinc-900">
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-zinc-800 hover:bg-zinc-800">
                <td className={`${tdCls} font-medium text-zinc-100`}>
                  {row.item_name}
                  {row.variation_name && row.variation_name !== "Regular" && (
                    <span className="ml-2 text-xs text-zinc-500">({row.variation_name})</span>
                  )}
                </td>
                <td className={`${tdCls} text-right text-zinc-300`}>{row.peak_qty}</td>
                <td className={`${tdCls} text-right text-zinc-200`}>{row.latest_qty}</td>
                <td className={`${tdCls} text-right ${pctColor(row.pct_remaining)}`}>
                  {row.pct_remaining !== null ? `${row.pct_remaining}%` : "—"}
                </td>
                <td className={`${tdCls} text-right ${pctColor(row.avg_shrinkage_pct)}`}>
                  {row.avg_shrinkage_pct !== null ? `${row.avg_shrinkage_pct}%` : "—"}
                </td>
                <td className={`${tdCls}`}>
                  <div className="flex flex-wrap gap-2">
                    {row.counts.map((c, j) => (
                      <span key={j} className="inline-flex items-center gap-1 text-xs text-zinc-400">
                        <span className="text-zinc-500">{c.date}:</span>
                        <span className="text-zinc-200">{c.qty} oz</span>
                        {c.shrinkage_pct !== null && (
                          <span className={`${pctColor(c.shrinkage_pct)} font-medium`}>
                            (↓{c.shrinkage_pct}%)
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ShrinkageReport() {
  const [start, setStart]     = useState(ninetyDaysAgo());
  const [end, setEnd]         = useState(today());
  const [draft, setDraft]     = useState<ItemRow[] | null>(null);
  const [liquor, setLiquor]   = useState<ItemRow[] | null>(null);
  const [chartData, setChartData]   = useState<Record<string, unknown>[] | null>(null);
  const [chartItems, setChartItems] = useState<ChartItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  async function runReport() {
    setLoading(true); setError(null);
    setDraft(null); setLiquor(null); setChartData(null); setChartItems([]);
    try {
      const res  = await fetch(`/api/shrinkage?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setDraft(data.draft);
      setLiquor(data.liquor);
      setChartData(data.chart_data);
      setChartItems(data.chart_items);
    } catch (e) { setError(e instanceof Error ? e.message : "Unknown error"); }
    finally { setLoading(false); }
  }

  const hasData = !!(draft?.length || liquor?.length);
  const hasChartData = chartData && chartData.length > 0 && chartItems.length > 0;

  return (
    <div>
      <ReportControls
        start={start} end={end} onStartChange={setStart} onEndChange={setEnd}
        onRun={runReport} loading={loading} hasData={hasData}
        groupBy="none" groupOptions={[]} onGroupByChange={() => {}}
      />

      {error && <div className="mt-4 p-3 bg-red-950 border border-red-700 rounded-md text-sm text-red-300">{error}</div>}

      {draft !== null && (
        <div className="mt-4 space-y-6">

          {/* Draft section */}
          <ItemTable rows={draft} title="Draft Beer" />

          {/* Liquor section */}
          <ItemTable rows={liquor ?? []} title="Liquor" />

          {/* Line chart */}
          {hasChartData ? (
            <div>
              <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                Shrinkage Over Time (% depletion per count period)
              </h3>
              <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-4">
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
                    <XAxis
                      dataKey="week"
                      tick={{ fill: "#a1a1aa", fontSize: 12 }}
                      tickLine={{ stroke: "#52525b" }}
                      axisLine={{ stroke: "#52525b" }}
                    />
                    <YAxis
                      tick={{ fill: "#a1a1aa", fontSize: 12 }}
                      tickLine={{ stroke: "#52525b" }}
                      axisLine={{ stroke: "#52525b" }}
                      tickFormatter={(v) => `${v}%`}
                      domain={[0, 100]}
                      label={{ value: "% Depletion", angle: -90, position: "insideLeft", fill: "#71717a", fontSize: 11, dy: 50 }}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: "6px" }}
                      labelStyle={{ color: "#e4e4e7", fontWeight: 600 }}
                      itemStyle={{ color: "#a1a1aa" }}
                      formatter={(value, name) => {
                        if (value === null || value === undefined) return ["No data", String(name)];
                        return [`${value}%`, String(name)];
                      }}
                    />
                    <Legend
                      wrapperStyle={{ color: "#a1a1aa", fontSize: 12, paddingTop: 12 }}
                    />
                    {chartItems.map((item, idx) => (
                      <Line
                        key={item.name}
                        type="monotone"
                        dataKey={item.name}
                        stroke={LINE_COLORS[idx % LINE_COLORS.length]}
                        strokeWidth={2}
                        dot={{ r: 4, fill: LINE_COLORS[idx % LINE_COLORS.length] }}
                        connectNulls={false}
                        activeDot={{ r: 6 }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : (
            draft !== null && (
              <div>
                <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                  Shrinkage Over Time
                </h3>
                <p className="text-sm text-zinc-500">
                  Not enough consecutive count data to plot a trend. Shrinkage trends will appear here once items have been counted more than once.
                </p>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
