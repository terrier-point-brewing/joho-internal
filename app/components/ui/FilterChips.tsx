"use client";

/**
 * Segmented chip filter. Single-select by default; `multiple` toggles membership.
 * `value` is the selected values ([] = All). Promoted from the inline Export Bay
 * version. For data-category dimensions (channel, etc.) pass category color
 * classes via `options[].className` — those are the sanctioned raw-color exception.
 */
export default function FilterChips({
  label,
  options,
  value,
  onChange,
  multiple = false,
  allLabel = "All",
  className = "",
}: {
  label: string;
  options: { value: string; label: string; className?: string }[];
  value: string[];
  onChange: (v: string[]) => void;
  multiple?: boolean;
  allLabel?: string;
  className?: string;
}) {
  const isAll = value.length === 0;

  function pick(v: string) {
    if (!multiple) {
      onChange([v]);
      return;
    }
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  const chip = (selected: boolean, extra = "") =>
    `text-xs px-2 py-0.5 rounded border transition-colors ${
      selected
        ? "border-accent-border bg-accent-muted/40 text-accent-soft"
        : "border-line-strong text-secondary hover:border-line-subtle hover:text-body"
    } ${extra}`.trim();

  return (
    <div className={`flex items-center gap-1.5 flex-wrap ${className}`.trim()}>
      <span className="text-xs text-muted mr-0.5">{label}:</span>
      <button type="button" onClick={() => onChange([])} className={chip(isAll)}>
        {allLabel}
      </button>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => pick(o.value)}
          className={chip(value.includes(o.value), o.className ?? "")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
