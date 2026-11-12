/**
 * Placeholder while a chart bundle loads. With no `height` it is a
 * `.chart-box` (phone / desktop / landscape heights from globals.css), the
 * same box the chart itself renders into, so nothing jumps when it arrives.
 */
export default function ChartSkeleton({ height }: { height?: number | string }) {
  return (
    <div
      className={`w-full animate-pulse rounded-lg bg-surface/40 ${height === undefined ? "chart-box" : ""}`}
      style={height === undefined ? undefined : { height }}
      aria-hidden="true"
    />
  );
}
