import type { SortState } from "@/lib/table/types";

/**
 * Sortable table header cell. Unifies the two prior `SortTh` implementations.
 * Shows ↑ / ↓ when active, ↕ when inactive.
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
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={`px-4 py-3 font-medium text-body cursor-pointer select-none whitespace-nowrap hover:text-primary transition-colors text-${align} ${className}`.trim()}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-xs ${active ? "text-accent" : "text-faint"}`}>
          {active ? (sort!.dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </span>
    </th>
  );
}
