export default function Loading() {
  // Body-only skeleton — the Transactions layout supplies the nav + header.
  return (
    <div className="flex-1 overflow-hidden px-4 sm:px-6 py-4">
      <div className="rounded-lg border border-line bg-surface/40 p-4 space-y-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-8 w-full rounded bg-surface/70 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
