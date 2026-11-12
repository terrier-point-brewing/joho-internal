import { type ReactNode } from "react";

/**
 * A label beside a control (docs/UI_STANDARD.md §7, pattern C). From `sm`
 * the label sits left at a fixed width and the control takes the rest; on a
 * phone the label stacks above the control, which gets the full row. The
 * fixed-width-label-next-to-a-select row was the single most repeated reason
 * a select ended up 14px wide on a phone.
 */
export default function FieldRow({
  label,
  children,
  labelWidth = "sm:w-28",
  className = "",
  align = "center",
}: {
  label: ReactNode;
  children: ReactNode;
  /** A `sm:w-*` utility for the label column. */
  labelWidth?: string;
  className?: string;
  align?: "center" | "start";
}) {
  return (
    <div className={`flex flex-col sm:flex-row ${align === "center" ? "sm:items-center" : "sm:items-start"} gap-1 sm:gap-2 ${className}`.trim()}>
      <div className={`text-xs text-muted shrink-0 ${labelWidth} truncate`}>{label}</div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
