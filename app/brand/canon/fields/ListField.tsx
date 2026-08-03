"use client";

import type { ReactNode } from "react";

/**
 * Generic add / remove / reorder wrapper for a list of canon items.
 *
 * Together with the typed inputs each concrete field supplies, this retires the
 * raw-JSON editing that made edits fail silently: a mistyped brace used to stop
 * the value ever reaching the draft while the UI reported "No unsaved changes".
 * There is no longer a blob to mistype.
 *
 * Reordering moves whole item objects rather than rebuilding them, so `id`
 * survives. diffCanon matches items by id — rebuilding on reorder would make
 * every publish report the whole list as removed and re-added.
 */
export default function ListField<T>({
  label,
  description,
  items,
  onChange,
  blank,
  renderItem,
  addLabel = "Add",
}: {
  label: string;
  description?: string;
  items: T[];
  onChange: (next: T[]) => void;
  blank: () => T;
  renderItem: (item: T, update: (patch: Partial<T>) => void) => ReactNode;
  addLabel?: string;
}) {
  function update(index: number, patch: Partial<T>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function remove(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</h3>
          {description && <p className="text-xs text-faint mt-1">{description}</p>}
        </div>
        <button
          type="button"
          className="btn-secondary shrink-0"
          onClick={() => onChange([...items, blank()])}
        >
          {addLabel}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {items.map((item, i) => (
          <div key={i} className="bg-surface-mid border border-line rounded-md p-2">
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">{renderItem(item, (patch) => update(i, patch))}</div>
              <div className="flex flex-col gap-1 shrink-0">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${label} item ${i + 1} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={i === items.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${label} item ${i + 1} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => remove(i)}
                  aria-label={`Remove ${label} item ${i + 1}`}
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <p className="text-sm text-faint">Nothing here yet — add the first entry.</p>
        )}
      </div>
    </div>
  );
}
