import type { SortState } from "@/lib/table/types";

/**
 * Sortable table header cell. Unifies the two prior `SortTh` implementations.
 * Shows ↑ / ↓ when active, ↕ when inactive. The clickable part is a real
 * <button> (keyboard-reachable, takes the global focus ring) and the <th>
 * carries `aria-sort` so assistive tech announces the current order.
 */
export default function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
  className = "",
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort?.key === sortKey;
  const ariaSort = active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none";
  return (
    <th
      aria-sort={ariaSort}
      className={`px-4 py-3 font-medium text-body select-none whitespace-nowrap text-${align} ${className}`.trim()}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 w-full cursor-pointer hover:text-primary transition-colors ${
          align === "right" ? "justify-end" : ""
        }`.trim()}
      >
        {label}
        <span aria-hidden className={`text-xs ${active ? "text-accent" : "text-faint"}`}>
          {active ? (sort!.dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}
