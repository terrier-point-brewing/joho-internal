import { type ReactNode } from "react";

/**
 * A title (or name) with a cluster of actions beside it (docs/UI_STANDARD.md
 * §7, pattern C). The title takes the slack and may truncate; the actions
 * keep their size and, on a phone, wrap onto their own line instead of
 * crushing the title to a few characters. Use for card headers, panel
 * toolbars and any `justify-between` row that pairs text with buttons.
 */
export default function TitleRow({
  title,
  actions,
  className = "",
  wrap = "sm",
}: {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Below which breakpoint the actions drop to their own line. "never" keeps one row. */
  wrap?: "sm" | "md" | "never";
}) {
  const titleCls = wrap === "sm" ? "max-sm:basis-full" : wrap === "md" ? "max-md:basis-full" : "";
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${className}`.trim()}>
      <div className={`flex-1 min-w-0 ${titleCls}`}>{title}</div>
      {actions && <div className="flex flex-wrap items-center gap-2 ml-auto">{actions}</div>}
    </div>
  );
}
