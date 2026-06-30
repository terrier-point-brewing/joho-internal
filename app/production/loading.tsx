export default function Loading() {
  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-3">
        <div className="h-5 w-44 rounded bg-zinc-800/70 animate-pulse" />
      </div>
      <div className="flex-1 overflow-hidden px-4 sm:px-6 py-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="h-28 rounded-lg bg-zinc-900/60 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
