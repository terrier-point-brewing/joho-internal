import { type ReactNode } from "react";

/**
 * A row of short fields or stats (docs/UI_STANDARD.md §7 C). `cols` is the
 * count from `sm` up; `phone` is the count below it. The default of two keeps
 * a date or a select wide enough to read and tap; pass 1 for long controls,
 * 3 only for bare numbers. Never write an unprefixed `grid-cols-3+`.
 */
const WIDE = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4", 5: "sm:grid-cols-5" } as const;
const PHONE = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3" } as const;
const GAP = { 2: "gap-2", 3: "gap-3", 4: "gap-4" } as const;

export default function FieldGrid({
  children,
  cols,
  phone = 2,
  gap = 3,
  className = "",
}: {
  children: ReactNode;
  cols: keyof typeof WIDE;
  phone?: keyof typeof PHONE;
  gap?: keyof typeof GAP;
  className?: string;
}) {
  return <div className={`grid ${PHONE[phone]} ${WIDE[cols]} ${GAP[gap]} ${className}`.trim()}>{children}</div>;
}
