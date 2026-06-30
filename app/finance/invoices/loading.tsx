export default function Loading() {
  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-6 pb-4">
        <div className="h-6 w-40 rounded bg-zinc-800/70 animate-pulse" />
        <div className="mt-2 h-3 w-80 rounded bg-zinc-900 animate-pulse" />
      </div>
      <div className="flex-1 overflow-hidden px-4 sm:px-6 py-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-8 w-full rounded bg-zinc-900/70 animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}
