"use client";

import { useEffect, useId, useRef, useState } from "react";

export interface SearchComboboxItem {
  id: string;
  /** Primary text; what the search matches against (with `sub`). */
  label: string;
  /** Secondary text shown after the label in muted type. */
  sub?: string | null;
  /** Right-aligned small hint (a category, a stock count). Not searched. */
  hint?: string | null;
}

type Props = {
  value: string;
  onChange: (id: string) => void;
  items: SearchComboboxItem[];
  placeholder?: string;
  /** Shown when nothing matches. Defaults to "No matches". */
  emptyLabel?: string;
  /** Hide the × clear control (for required pickers that must always hold a value). */
  clearable?: boolean;
  required?: boolean;
  className?: string;
};

function matches(item: SearchComboboxItem, query: string): boolean {
  if (!query) return true;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${item.label} ${item.sub ?? ""}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * A typeahead picker for lists too long for a native `<select>`.
 *
 * Click or focus opens the list with every item; typing narrows it by any
 * word of the label or sub-label. Arrow keys move, Enter picks, Escape closes.
 * The input shows the selected item's label while closed.
 */
export function SearchCombobox({
  value,
  onChange,
  items,
  placeholder = "Search…",
  emptyLabel = "No matches",
  clearable = true,
  required,
  className,
}: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = items.find((i) => i.id === value);
  const displayName = selected ? `${selected.label}${selected.sub ? ` · ${selected.sub}` : ""}` : "";
  const filtered = items.filter((i) => matches(i, query));

  function close() {
    setOpen(false);
    setQuery("");
    setActive(0);
  }

  function openWith(q: string) {
    setQuery(q);
    setActive(0);
    setOpen(true);
  }

  function pick(id: string) {
    onChange(id);
    close();
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      e.preventDefault();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = filtered[active];
      if (hit) pick(hit.id);
    }
  }

  return (
    <div ref={wrapRef} className={`relative${className ? ` ${className}` : ""}`}>
      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none text-xs">⌕</span>
        <input
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          className={`inp w-full pl-6${clearable && value ? " pr-7" : ""}`}
          value={open ? query : displayName}
          placeholder={placeholder}
          required={required && !value}
          aria-controls={listId}
          onChange={(e) => openWith(e.target.value)}
          onFocus={() => openWith("")}
          onClick={() => { if (!open) openWith(""); }}
          onKeyDown={onKeyDown}
        />
        {clearable && value && (
          <button
            type="button"
            aria-label="Clear"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-secondary text-xs"
            onMouseDown={(e) => { e.preventDefault(); onChange(""); }}
          >
            ×
          </button>
        )}
      </div>
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-lg border border-line-strong bg-surface shadow-xl"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-xs text-faint italic text-center">
              {emptyLabel}{query ? ` for "${query}"` : ""}
            </div>
          ) : (
            filtered.map((item, idx) => {
              const isSelected = item.id === value;
              const isActive = idx === active;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`w-full text-left px-3 py-2.5 text-xs border-b border-line/40 last:border-0 transition-colors ${
                    isSelected
                      ? "bg-accent-muted/30 text-accent-soft"
                      : isActive
                        ? "bg-surface-mid text-body"
                        : "text-body hover:bg-surface-mid"
                  }`}
                  onMouseEnter={() => setActive(idx)}
                  onMouseDown={(e) => { e.preventDefault(); pick(item.id); }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span>
                      <span className="font-medium">{item.label}</span>
                      {item.sub && <span className="text-muted ml-1.5">· {item.sub}</span>}
                    </span>
                    {item.hint && <span className="text-[10px] text-faint shrink-0">{item.hint}</span>}
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
