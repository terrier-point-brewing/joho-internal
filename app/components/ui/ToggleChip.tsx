"use client";

import type { ReactNode } from "react";

/**
 * The single chip affordance used across table control rows — one on/off pill.
 * `FilterChips` composes it for its segmented options; view toggles (group-by,
 * show-archived) use it directly instead of hand-rolling a bordered button.
 * For data-category dimensions pass category color classes via `className` —
 * those are the sanctioned raw-color exception.
 */
export default function ToggleChip({
  active,
  onClick,
  children,
  className = "",
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`text-xs px-2 py-0.5 rounded border transition-colors ${
        active
          ? "border-accent-border bg-accent-muted/40 text-accent-soft"
          : "border-line-strong text-secondary hover:border-line-subtle hover:text-body"
      } ${className}`.trim()}
    >
      {children}
    </button>
  );
}
