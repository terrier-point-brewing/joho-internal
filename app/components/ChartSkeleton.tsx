export default function ChartSkeleton({ height = 280 }: { height?: number }) {
  return (
    <div
      className="w-full animate-pulse rounded-lg bg-zinc-900/40"
      style={{ height }}
      aria-hidden="true"
    />
  );
}
