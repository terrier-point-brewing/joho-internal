"use client";

import { type ReactNode } from "react";
import { formatCurrency } from "@/lib/format";

// ---------------------------------------------------------------------------
// Shared report-table chrome. The 7 report components all copy-pasted the same
// `overflow-x-auto rounded-lg border` wrapper + `min-w-full text-sm` table, the
// `tdCls` cell padding, identical thead/tbody/tfoot row classes, and a local
// `currency()` formatter. They are centralized here. Each report still owns its
// own columns/rows — it passes <thead>/<tbody>/<tfoot> as children.
// ---------------------------------------------------------------------------

/** Default table cell padding (one value per table, per UI_STANDARD §3). */
export const tdCls = "px-4 py-2";

/** Numeric/money cell modifier — right-aligned, monospace, tabular figures. */
export const numCls = `${tdCls} text-right font-mono tabular-nums`;

/** Header row (`<thead><tr>`). */
export const THEAD_ROW = "border-b border-line-strong bg-surface-mid";
/** Body wrapper (`<tbody>`). */
export const TBODY = "bg-surface";
/** Body data row (`<tbody><tr>`). */
export const TR = "border-b border-line hover:bg-surface-mid";
/** Footer / totals row (`<tfoot><tr>`). */
export const TFOOT_ROW = "border-t-2 border-line-subtle bg-surface-mid font-semibold";

/** Currency formatter shared across reports (accepts string or number). */
export function currency(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return formatCurrency(n);
}

/**
 * Shared scroll container + bordered table shell. Render thead/tbody/tfoot as
 * children. Use the exported row-class constants above for consistent chrome.
 */
export default function ReportTable({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line-strong">
      <table className={`min-w-full text-sm ${className}`.trim()}>{children}</table>
    </div>
  );
}
