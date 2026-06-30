"use client";

import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import { formatCurrency } from "@/lib/format";

type Grain = "monthly" | "weekly";
type ChartView = "per-period" | "cumulative";

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface-mid border border-line-strong rounded px-3 py-2 text-xs shadow-lg">
      <div className="text-body font-medium mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color }} className="flex justify-between gap-4">
          <span>{p.name}</span>
          <span className="font-mono">{p.value != null ? formatCurrency(p.value, 0) : "—"}</span>
        </div>
      ))}
    </div>
  );
}

export interface AchievementChartDatum {
  name: string;
  "Net Sales"?: number;
  "Forecast"?: number;
  "Cumulative"?: number;
  "Forecast Total"?: number;
  _isInProgress: boolean;
}

export default function AchievementChart({
  chartData, chartView, grain, yDomain,
  perPeriodTargetDollars, cumulativeTargetDollars, activeTierColor, tierLabel,
}: {
  chartData: AchievementChartDatum[];
  chartView: ChartView;
  grain: Grain;
  yDomain: [number, number];
  perPeriodTargetDollars: number | null;
  cumulativeTargetDollars: number | null;
  activeTierColor: string;
  tierLabel: string;
}) {
  const yAxisFmt = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v.toFixed(0)}`;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={chartData}
        margin={{ top: 8, right: 16, bottom: grain === "weekly" ? 30 : 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
        <XAxis dataKey="name" interval={0}
          tick={grain === "weekly" ? { fill: "#a1a1aa", fontSize: 10, dy: 4 } : { fill: "#a1a1aa", fontSize: 11 }}
          angle={grain === "weekly" ? -45 : 0}
          textAnchor={grain === "weekly" ? "end" : "middle"}
          axisLine={false} tickLine={false}
          height={grain === "weekly" ? 52 : 24} />
        <YAxis tickFormatter={yAxisFmt} domain={yDomain}
          tick={{ fill: "#a1a1aa", fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
        <Tooltip content={<ChartTooltip />} />

        {chartView === "per-period" && (
          <>
            {perPeriodTargetDollars !== null && (
              <ReferenceLine y={perPeriodTargetDollars} stroke={activeTierColor}
                strokeDasharray="5 4" strokeWidth={1.5}
                label={{ value: `Avg ${tierLabel}`, position: "insideTopRight", fill: activeTierColor, fontSize: 10 }} />
            )}
            <Line type="monotone" dataKey="Net Sales" stroke="#60a5fa" strokeWidth={2}
              dot={{ r: 4, fill: "#60a5fa", strokeWidth: 0 }} activeDot={{ r: 5 }} connectNulls={false} />
            <Line type="monotone" dataKey="Forecast" stroke="#60a5fa" strokeWidth={2}
              strokeDasharray="5 4" dot={{ r: 4, fill: "#60a5fa", strokeWidth: 0, opacity: 0.5 }}
              activeDot={{ r: 5 }} connectNulls={false} />
          </>
        )}
        {chartView === "cumulative" && (
          <>
            {cumulativeTargetDollars !== null && (
              <ReferenceLine y={cumulativeTargetDollars} stroke={activeTierColor}
                strokeDasharray="5 4" strokeWidth={1.5}
                label={{ value: tierLabel, position: "insideTopRight", fill: activeTierColor, fontSize: 10 }} />
            )}
            <Line type="monotone" dataKey="Cumulative" stroke="#34d399" strokeWidth={2}
              dot={{ r: 4, fill: "#34d399", strokeWidth: 0 }} activeDot={{ r: 5 }} connectNulls={false} />
            <Line type="monotone" dataKey="Forecast Total" stroke="#34d399" strokeWidth={2}
              strokeDasharray="5 4" dot={{ r: 4, fill: "#34d399", strokeWidth: 0, opacity: 0.5 }}
              activeDot={{ r: 5 }} connectNulls={false} />
          </>
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
