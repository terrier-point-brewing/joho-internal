export default function Loading() {
  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-3">
        <div className="h-5 w-48 rounded bg-surface-mid/70 animate-pulse" />
        <div className="mt-2 h-3 w-72 rounded bg-surface animate-pulse" />
      </div>
      <div className="flex-1 overflow-hidden px-4 sm:px-6 py-4 space-y-2">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="h-7 w-full rounded bg-surface/60 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
