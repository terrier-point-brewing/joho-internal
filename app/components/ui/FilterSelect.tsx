"use client";

/**
 * Categorical dropdown filter (single-select). Use when a dimension has more
 * than ~5 options or space is tight; otherwise prefer FilterChips.
 * `value` is [] (All) or a single-element array.
 */
export default function FilterSelect({
  label,
  options,
  value,
  onChange,
  allLabel = "All",
  className = "",
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (v: string[]) => void;
  allLabel?: string;
  className?: string;
}) {
  return (
    <label className={`inline-flex items-center gap-1.5 ${className}`.trim()}>
      <span className="text-xs text-muted">{label}:</span>
      <select
        value={value[0] ?? ""}
        onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
        className="inp-sm w-auto"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
