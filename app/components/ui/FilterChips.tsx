"use client";

import ToggleChip from "./ToggleChip";

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

  // Below `sm` a single-select group is one native select (docs/UI_STANDARD.md
  // §7 E): a row of chips beside the search box wraps into two or three
  // toolbar rows on a phone. Multi-select keeps its chips, which a select
  // cannot express.
  const asSelect = !multiple;
  return (
    <>
      <div className={`flex items-center gap-1.5 flex-wrap ${asSelect ? "max-sm:hidden" : ""} ${className}`.replace(/\s+/g, " ").trim()}>
        <span className="text-xs text-muted mr-0.5">{label}:</span>
        <ToggleChip active={isAll} onClick={() => onChange([])}>
          {allLabel}
        </ToggleChip>
        {options.map((o) => (
          <ToggleChip
            key={o.value}
            active={value.includes(o.value)}
            onClick={() => pick(o.value)}
            className={o.className ?? ""}
          >
            {o.label}
          </ToggleChip>
        ))}
      </div>
      {asSelect && (
        <label className="sm:hidden inline-flex items-center gap-1.5">
          <span className="text-xs text-muted">{label}:</span>
          <select
            value={value[0] ?? ""}
            onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
            className="inp-sm w-auto max-w-36"
          >
            <option value="">{allLabel}</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}
