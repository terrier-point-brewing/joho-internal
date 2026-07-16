"use client";

/** Shared from/to date-range picker, replacing the plain Year dropdown. */
export default function DateRangeFilter({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input type="date" value={from} max={to} onChange={(e) => onChange(e.target.value, to)} className="inp-sm w-auto" />
      <span className="text-faint text-xs">–</span>
      <input type="date" value={to} min={from} onChange={(e) => onChange(from, e.target.value)} className="inp-sm w-auto" />
    </div>
  );
}
