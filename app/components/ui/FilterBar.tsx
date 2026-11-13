"use client";

import { Children, isValidElement, useState, type ReactNode } from "react";
import SearchInput from "./SearchInput";

/**
 * Layout container for a table's controls. Pages compose SearchInput /
 * FilterChips / FilterSelect (and domain selectors like YearSelect) as children.
 * Renders a "Clear (N)" button when activeCount > 0 and onClear is provided.
 *
 * Desktop: one wrapping row. Phone (`< sm`), per docs/UI_STANDARD.md §7 E:
 *
 * - The search box is never folded away. It is the control a phone reader
 *   reaches for first, so it keeps the first row and takes the spare width.
 * - One other control sits beside it on that row.
 * - Two or more fold behind a "Filters" button that sits beside the search
 *   box (not a row of its own), so the table is on the first screen instead
 *   of after seven rows of chips. `collapsible` overrides the default.
 */
export default function FilterBar({
  children,
  activeCount = 0,
  onClear,
  className = "",
  collapsible,
}: {
  children: ReactNode;
  activeCount?: number;
  onClear?: () => void;
  className?: string;
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const all = Children.toArray(children);
  const isSearch = (c: ReactNode) => isValidElement(c) && c.type === SearchInput;
  const search = all.filter(isSearch);
  const rest = all.filter((c) => !isSearch(c));
  const folds = collapsible ?? rest.length > 1;
  const toggleLabel = open ? "Hide filters" : activeCount > 0 ? `Filters (${activeCount})` : "Filters";
  const clear = onClear && activeCount > 0 && (
    <button type="button" onClick={onClear} className="btn-secondary">
      Clear ({activeCount})
    </button>
  );
  return (
    <div className={`flex flex-wrap items-center gap-2 sm:gap-3 ${className}`.trim()}>
      {search.map((s, i) => (
        <div key={i} className="flex-1 min-w-36 sm:flex-none">{s}</div>
      ))}
      {folds ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className={`btn-secondary sm:hidden ${search.length === 0 ? "w-full" : ""}`.trim()}
          >
            {toggleLabel}
          </button>
          <div className={`max-sm:basis-full max-sm:grid max-sm:grid-cols-1 max-sm:gap-2 sm:contents ${open ? "" : "max-sm:hidden"}`.trim()}>
            {rest}
            {clear}
          </div>
        </>
      ) : (
        <>
          {rest}
          {clear}
        </>
      )}
    </div>
  );
}
