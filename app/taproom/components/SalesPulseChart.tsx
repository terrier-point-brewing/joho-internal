"use client";

import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { formatCurrencyCents } from "@/lib/format";

type KpiMetric = "net_sales" | "gross_sales" | "avg_ticket" | "guest_count";

function ChartTooltip({
  active, payload, label, metric,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string; strokeDasharray?: string }[];
  label?: string;
  metric: KpiMetric;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs shadow-lg">
      <div className="text-zinc-300 font-medium mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color }} className="flex justify-between gap-4">
          <span>{p.name}</span>
          <span className="font-mono">
            {metric === "guest_count"
              ? Math.round(p.value ?? 0).toLocaleString()
              : formatCurrencyCents((p.value ?? 0) * 100, 0)}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface SalesPulseChartDatum {
  day: string;
  "This Week"?: number;
  "Prior Week"?: number;
}

export default function SalesPulseChart({
  chartData, chartMetric,
}: {
  chartData: SalesPulseChartDatum[];
  chartMetric: KpiMetric;
}) {
  const yAxisFmt = (v: number) => {
    if (chartMetric === "guest_count") return String(v);
    if (v >= 1000) return `$${(v / 1000).toFixed(0)}k`;
    return `$${v.toFixed(0)}`;
  };

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
        <XAxis
          dataKey="day"
          tick={{ fill: "#a1a1aa", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tickFormatter={yAxisFmt}
          tick={{ fill: "#a1a1aa", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={44}
        />
        <Tooltip content={<ChartTooltip metric={chartMetric} />} />
        <Legend
          wrapperStyle={{ fontSize: 12, color: "#a1a1aa", paddingTop: 8 }}
          formatter={(value) => <span style={{ color: "#a1a1aa" }}>{value}</span>}
        />
        <Line
          type="monotone"
          dataKey="This Week"
          stroke="#f59e0b"
          strokeWidth={2}
          dot={{ r: 4, fill: "#f59e0b", strokeWidth: 0 }}
          activeDot={{ r: 5 }}
          connectNulls={false}
        />
        <Line
          type="monotone"
          dataKey="Prior Week"
          stroke="#60a5fa"
          strokeWidth={2}
          strokeDasharray="5 4"
          dot={{ r: 3, fill: "#60a5fa", strokeWidth: 0 }}
          activeDot={{ r: 4 }}
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
