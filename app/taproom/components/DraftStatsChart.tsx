"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";

interface ChartDatum { date: string; recipe: string; shrinkage_fl_oz: number; shrinkage_pct: number }
interface ShrinkageColorItem { beer_name: string; color: string }

export default function DraftStatsChart({
  chartData, chartByShrinkageItem,
}: {
  chartData: ChartDatum[];
  chartByShrinkageItem: ShrinkageColorItem[];
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={chartData} margin={{ top: 5, right: 16, left: 0, bottom: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
        <XAxis
          dataKey="date"
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
          contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: "6px", fontSize: 12, color: "#e4e4e7" }}
          labelStyle={{ color: "#e4e4e7", fontWeight: 600 }}
          itemStyle={{ color: "#a1a1aa" }}
          formatter={(val, _name, props) => [
            `${val} fl oz (${props.payload?.shrinkage_pct ?? 0}%)`,
            props.payload?.recipe ?? "",
          ]}
        />
        <Bar dataKey="shrinkage_fl_oz" radius={[2, 2, 0, 0]}>
          {chartData.map((entry, idx) => {
            const color = chartByShrinkageItem.find((i) => i.beer_name === entry.recipe)?.color ?? "#a1a1aa";
            return <Cell key={idx} fill={color} fillOpacity={0.8} />;
          })}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
