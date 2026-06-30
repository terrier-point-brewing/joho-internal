export default function ChartSkeleton({ height = 280 }: { height?: number }) {
  return (
    <div
      className="w-full animate-pulse rounded-lg bg-surface/40"
      style={{ height }}
      aria-hidden="true"
    />
  );
}
