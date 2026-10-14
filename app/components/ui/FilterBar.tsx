"use client";

import { Children, useState, type ReactNode } from "react";

/**
 * Layout container for a table's controls. Pages compose SearchInput /
 * FilterChips / FilterSelect (and domain selectors like YearSelect) as children.
 * Renders a "Clear (N)" button when activeCount > 0 and onClear is provided.
 *
 * Desktop: one wrapping row. Phone (`< sm`): a one-column grid where every
 * control fills the width, and — when the bar holds more than one control —
 * the whole bar folds behind a single "Filters" button so the table is
 * visible on first paint instead of after seven rows of chips. A bar with a
 * lone search box stays open. `collapsible` overrides the default either way.
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
  const folds = collapsible ?? Children.count(children) > 1;
  const toggleLabel = open ? "Hide filters" : activeCount > 0 ? `Filters (${activeCount})` : "Filters";
  return (
    <div className={className}>
      {folds && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="btn-secondary w-full sm:hidden mb-2"
        >
          {toggleLabel}
        </button>
      )}
      <div
        className={`grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-3 ${
          folds && !open ? "max-sm:hidden" : ""
        }`.trim()}
      >
        {children}
        {onClear && activeCount > 0 && (
          <button type="button" onClick={onClear} className="btn-secondary">
            Clear ({activeCount})
          </button>
        )}
      </div>
    </div>
  );
}
