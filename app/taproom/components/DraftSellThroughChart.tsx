"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";

export interface SellThroughSeries { key: string; label: string; color: string }

/** One stacked bar per business day; each segment is a beer's fl oz poured. */
export default function DraftSellThroughChart({
  chartData, series,
}: {
  chartData: Record<string, string | number>[];
  series: SellThroughSeries[];
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={chartData} margin={{ top: 5, right: 16, left: 0, bottom: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
        <XAxis
          dataKey="label"
          tick={{ fill: "#a1a1aa", fontSize: 11 }}
          tickLine={{ stroke: "#52525b" }}
          axisLine={{ stroke: "#52525b" }}
          angle={-30} textAnchor="end" height={45}
        />
        <YAxis
          tick={{ fill: "#a1a1aa", fontSize: 11 }}
          tickLine={{ stroke: "#52525b" }}
          axisLine={{ stroke: "#52525b" }}
          label={{ value: "fl oz", angle: -90, position: "insideLeft", fill: "#71717a", fontSize: 11, dy: 30 }}
        />
        <Tooltip
          cursor={{ fill: "#3f3f46", fillOpacity: 0.3 }}
          contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: "6px", fontSize: 12, color: "#e4e4e7" }}
          labelStyle={{ color: "#e4e4e7", fontWeight: 600 }}
          itemStyle={{ color: "#a1a1aa" }}
          formatter={(val, name) => [`${Math.round(Number(val)).toLocaleString()} fl oz`, name]}
        />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId="pours" fill={s.color} fillOpacity={0.8} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
