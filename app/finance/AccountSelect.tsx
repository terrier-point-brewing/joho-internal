"use client";
// Shared searchable Chart-of-Accounts picker. Consolidates three near-identical copies
// (invoices `CoASelect`, square-transactions `AccountSelect`, account-mapping `AccountSelect`).
// Presentation only — each call site keeps its own value/onChange wiring.

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

export interface CoARef {
  id: string;
  account_name: string;
  account_number: string | null;
  account_type: string;
}

function fullLabel(a: CoARef) {
  return a.account_number ? `${a.account_number} · ${a.account_name}` : a.account_name;
}

export function shortAccountName(name: string) {
  const parts = name.split(":");
  return parts[parts.length - 1].trim();
}

export default function AccountSelect({
  value,
  onChange,
  accounts,
  placeholder = "— no mapping —",
  prefilled,
  shortLabel = false,
  className = "w-full",
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  accounts: CoARef[];
  placeholder?: string;
  /** Highlights the trigger when a prefill is available but nothing is selected. */
  prefilled?: boolean;
  /** Render only the leaf account name (after the last ":") in the trigger. */
  shortLabel?: boolean;
  /** Wrapper width/utility classes (e.g. "w-full max-w-[300px]"). */
  className?: string;
}) {
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos]     = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const wrapRef           = useRef<HTMLDivElement>(null);
  const panelRef          = useRef<HTMLDivElement>(null);
  const inputRef          = useRef<HTMLInputElement>(null);

  // The panel renders in a portal (fixed positioning) so it can extend past the
  // table's overflow-clipping wrappers. Position is derived from the trigger's rect.
  // Flip above the trigger when there isn't room below (near the viewport bottom),
  // and cap the height to the available space so it never runs off-screen.
  const computePos = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 260);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));

    const GAP = 4;
    const MARGIN = 8;
    const PREFERRED = 256; // matches max-h-64
    const spaceBelow = window.innerHeight - r.bottom - GAP - MARGIN;
    const spaceAbove = r.top - GAP - MARGIN;
    const openUp = spaceBelow < PREFERRED && spaceAbove > spaceBelow;

    const maxHeight = Math.min(PREFERRED, Math.max(openUp ? spaceAbove : spaceBelow, 120));
    const top = openUp ? r.top - GAP - maxHeight : r.bottom + GAP;
    setPos({ top, left, width, maxHeight });
  }, []);

  const selected = accounts.find((a) => a.id === value) ?? null;

  const filtered = query.trim()
    ? accounts.filter((a) =>
        `${a.account_number ?? ""} ${a.account_name} ${a.account_type}`
          .toLowerCase()
          .includes(query.toLowerCase())
      )
    : accounts;

  const grouped = filtered.reduce<Record<string, CoARef[]>>((acc, a) => {
    (acc[a.account_type] ??= []).push(a);
    return acc;
  }, {});
  const groupEntries = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
      setQuery("");
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the portal panel anchored to the trigger while open (scroll/resize).
  useEffect(() => {
    if (!open) return;
    computePos();
    const onMove = () => computePos();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, computePos]);

  function handleOpen() {
    computePos();
    setOpen(true);
    setQuery("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleSelect(id: string | null) {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  const triggerLabel = selected
    ? (shortLabel
        ? (selected.account_number
            ? `${selected.account_number} · ${shortAccountName(selected.account_name)}`
            : shortAccountName(selected.account_name))
        : fullLabel(selected))
    : (prefilled ? "— prefill available —" : placeholder);

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={handleOpen}
        className={`w-full flex items-center justify-between gap-1 border rounded px-2 py-1 text-xs text-left focus:outline-none transition-colors ${
          prefilled && !selected
            ? "bg-accent-muted/10 border-accent-border/40 hover:border-accent-emphasis"
            : "bg-surface-mid border-line-strong hover:border-line-subtle focus:border-accent-border"
        }`}
        title={selected && shortLabel ? fullLabel(selected) : undefined}
      >
        <span className={`truncate ${selected ? "text-strong" : "text-muted"}`}>
          {triggerLabel}
        </span>
        <span className="text-faint shrink-0">⌄</span>
      </button>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          className="fixed z-50 bg-surface border border-line-strong rounded-lg shadow-xl flex flex-col"
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
        >
          <div className="p-1.5 border-b border-line shrink-0">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setQuery(""); } }}
              placeholder="Search accounts…"
              className="w-full bg-surface-mid rounded px-2 py-1 text-xs text-strong placeholder-faint focus:outline-none"
            />
          </div>

          <div className="overflow-y-auto">
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); handleSelect(null); }}
              className={`w-full text-left px-3 py-2 text-xs border-b border-line/50 transition-colors ${
                !value ? "text-accent bg-accent-muted/20" : "text-muted hover:bg-surface-mid"
              }`}
            >
              {placeholder}
            </button>

            {groupEntries.length === 0 && (
              <p className="px-3 py-3 text-xs text-faint italic text-center">No matches</p>
            )}

            {groupEntries.map(([type, accs]) => (
              <div key={type}>
                <div className="px-3 py-1 text-[10px] text-faint uppercase tracking-wider bg-surface/80 sticky top-0">
                  {type}
                </div>
                {accs
                  .sort((a, b) => (a.account_number ?? "").localeCompare(b.account_number ?? "") || a.account_name.localeCompare(b.account_name))
                  .map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); handleSelect(a.id); }}
                      className={`w-full text-left px-3 py-2 text-xs transition-colors border-t border-line/30 ${
                        a.id === value ? "bg-accent-muted/30 text-accent-soft" : "text-body hover:bg-surface-mid"
                      }`}
                    >
                      {a.account_number && (
                        <span className="text-muted font-mono mr-1.5">{a.account_number}</span>
                      )}
                      {a.account_name}
                    </button>
                  ))}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
