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
  disabled = false,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  /** Matches `.btn-*`'s `:disabled` treatment, so an in-flight or unavailable
   *  choice doesn't have to be hand-rolled as `pointer-events-none`. */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={`text-xs px-2 py-0.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? "border-accent-border bg-accent-muted/40 text-accent-soft"
          : "border-line-strong text-secondary hover:border-line-subtle hover:text-body"
      } ${className}`.trim()}
    >
      {children}
    </button>
  );
}
