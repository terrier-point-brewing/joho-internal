import type { ControlsConfig, ControlsState } from "./types";

/**
 * Coerce a value to a comparable primitive (number takes priority).
 *
 * Known limitation: the numeric guess is per-cell, not per-column — a string
 * that `parseFloat`s (e.g. "8 Ball Stout" → 8) sorts as a number while its
 * peers ("Hazy IPA") stay strings, which can misorder a text column that
 * happens to have leading digits. Acceptable for the common numeric/text cases;
 * if a column needs deterministic text ordering, have its `SortSpec.accessor`
 * return a non-numeric-leading string (or add a per-column type later).
 */
function coerce(v: unknown): number | string {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isNaN(n) ? v.toLowerCase() : n;
  }
  return String(v ?? "").toLowerCase();
}

function compare(a: unknown, b: unknown): number {
  const av = coerce(a);
  const bv = coerce(b);
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv));
}

/** Apply search boxes, categorical filters, and a single sort column to `rows`.
 *  Pure — never mutates the input. See applyControls.test.ts for the contract. */
export function applyControls<T>(
  rows: T[],
  config: ControlsConfig<T>,
  state: ControlsState,
): T[] {
  let out = rows;

  for (const spec of config.search ?? []) {
    const q = (state.search[spec.param] ?? "").trim().toLowerCase();
    if (!q) continue;
    out = out.filter((row) => {
      const raw = spec.accessor(row);
      const fields = Array.isArray(raw) ? raw : [raw];
      return fields.some((f) => (f ?? "").toString().toLowerCase().includes(q));
    });
  }

  for (const spec of config.filters ?? []) {
    const selected = state.filters[spec.param] ?? [];
    if (selected.length === 0) continue;
    out = out.filter((row) => selected.includes(spec.accessor(row)));
  }

  if (state.sort && config.sort) {
    const col = config.sort.columns.find((c) => c.key === state.sort!.key);
    if (col) {
      const dir = state.sort.dir === "asc" ? 1 : -1;
      out = [...out].sort((a, b) => compare(col.accessor(a), col.accessor(b)) * dir);
    }
  }

  return out;
}
