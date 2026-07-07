"use client";

/** Shared year picker — defaults to the current year plus the prior `span - 1`. */
export default function YearSelect({
  year,
  onChange,
  span = 5,
}: {
  year: number;
  onChange: (y: number) => void;
  span?: number;
}) {
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: span }, (_, i) => currentYear - i);
  return (
    <select
      value={year}
      onChange={(e) => onChange(Number(e.target.value))}
      className="inp-sm w-auto">
      {years.map((y) => <option key={y} value={y}>{y}</option>)}
    </select>
  );
}
