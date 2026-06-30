"use client";

import { useState, useMemo } from "react";

type SortDir = "asc" | "desc";

/** Coerce a field value to a comparable primitive (number takes priority). */
function coerce(v: unknown): number | string {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isNaN(n) ? v.toLowerCase() : n;
  }
  return String(v ?? "").toLowerCase();
}

/** Generic sort hook. Pass the rows you want to sort; get back sorted rows + controls. */
export function useSort<T>(rows: T[] | null) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const sorted = useMemo((): T[] | null => {
    if (!rows || !sortKey) return rows;
    return [...rows].sort((a, b) => {
      const av = coerce((a as Record<string, unknown>)[sortKey]);
      const bv = coerce((b as Record<string, unknown>)[sortKey]);
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, sortKey, sortDir]);

  return { sorted, sortKey, sortDir, handleSort };
}

// ---------------------------------------------------------------------------
// SortTh — a <th> that shows sort indicators and handles click
// ---------------------------------------------------------------------------

interface SortThProps {
  label: string;
  col: string;
  sortKey: string | null;
  sortDir: SortDir;
  onSort: (col: string) => void;
  align?: "left" | "right";
  className?: string;
}

const BASE_TH = "px-4 py-3 font-medium text-body cursor-pointer select-none whitespace-nowrap hover:text-primary transition-colors";

export function SortTh({ label, col, sortKey, sortDir, onSort, align = "left", className = "" }: SortThProps) {
  const active = sortKey === col;
  return (
    <th
      onClick={() => onSort(col)}
      className={`${BASE_TH} text-${align} ${className}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-xs ${active ? "text-accent" : "text-faint"}`}>
          {active ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </span>
    </th>
  );
}
