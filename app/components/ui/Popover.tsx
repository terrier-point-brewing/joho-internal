"use client";
import { type ReactNode } from "react";

/**
 * A small on-demand panel behind a button: the house shape for mechanism text
 * ("How flows work", a View menu) that a finance-literate reader wants once,
 * not under every row. Native `<details>` so it needs no state, closes on a
 * second click, and works without JavaScript.
 */
export default function Popover({
  label,
  children,
  align = "left",
  className = "",
}: {
  label: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <details className={`relative ${className}`.trim()}>
      <summary className="btn-secondary list-none cursor-pointer select-none [&::-webkit-details-marker]:hidden">
        {label}
      </summary>
      <div
        className={`absolute z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-surface p-3 text-xs text-secondary shadow-lg ${
          align === "right" ? "right-0" : "left-0"
        }`}
      >
        {children}
      </div>
    </details>
  );
}
