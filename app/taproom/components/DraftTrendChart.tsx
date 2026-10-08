"use client";

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";

export interface TrendSeries { key: string; label: string; color: string }

/** One line per beer across the window's buckets. */
export default function DraftTrendChart({
  chartData, series, unit, connectGaps,
}: {
  chartData: Record<string, string | number | null>[];
  series: TrendSeries[];
  unit: string;
  /** Bridge empty buckets — for sparse per-event metrics, where a gap is "no keg", not zero. */
  connectGaps: boolean;
}) {
  // Point markers only while there is room for them; a year of days is a smear.
  const showDots = connectGaps || chartData.length <= 31;
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={chartData} margin={{ top: 5, right: 16, left: 0, bottom: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
        <XAxis
          dataKey="label"
          tick={{ fill: "#a1a1aa", fontSize: 11 }}
          tickLine={{ stroke: "#52525b" }}
          axisLine={{ stroke: "#52525b" }}
          angle={-30} textAnchor="end" height={45} minTickGap={12}
        />
        <YAxis
          tick={{ fill: "#a1a1aa", fontSize: 11 }}
          tickLine={{ stroke: "#52525b" }}
          axisLine={{ stroke: "#52525b" }}
          label={{ value: unit, angle: -90, position: "insideLeft", fill: "#71717a", fontSize: 11, dy: 30 }}
        />
        <Tooltip
          contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: "6px", fontSize: 12, color: "#e4e4e7" }}
          labelStyle={{ color: "#e4e4e7", fontWeight: 600 }}
          itemSorter={(item) => -(Number(item.value) || 0)}
          formatter={(val, name) => [`${Math.round(Number(val)).toLocaleString()} ${unit}`, name]}
        />
        {series.map((s) => (
          <Line
            key={s.key}
            type="linear"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            dot={showDots ? { r: 2.5, fill: s.color, strokeWidth: 0 } : false}
            activeDot={{ r: 4 }}
            connectNulls={connectGaps}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
