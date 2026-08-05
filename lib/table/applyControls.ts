import type { ControlsConfig, ControlsState } from "./types";

/**
 * Coerce a value to a comparable primitive (number takes priority).
 *
 * A string is treated as numeric only if the WHOLE trimmed string parses as
 * a number (`Number`, not `parseFloat`) — this is what makes ISO date
 * strings ("2026-07-09" / "2026-07-09T14:23:11Z") fall through to the string
 * branch (where `localeCompare` sorts them correctly, since ISO 8601 is
 * lexicographically chronological) instead of being truncated at the first
 * "-" into their year. It also keeps numeric-leading text ("8 Ball Stout")
 * as text rather than misreading it as the number 8.
 */
function coerce(v: unknown): number | string {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = v.trim();
    const n = t === "" ? NaN : Number(t);
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
    const matches = (f: string | null | undefined) => (f ?? "").toString().toLowerCase().includes(q);
    out = out.filter((row) => {
      const raw = spec.accessor(row);
      const fields = Array.isArray(raw) ? raw : [raw];
      return fields.some((f) => matches(f));
    });
    // Container rows narrow to their matching sub-items, using the same
    // `matches` the row was selected with (see SearchSpec.narrow).
    if (spec.narrow) out = out.map((row) => spec.narrow!(row, matches));
  }

  for (const spec of config.filters ?? []) {
    const selected = state.filters[spec.param] ?? [];
    if (selected.length === 0) continue;
    const pred = spec.matches ?? ((row: T, sel: string[]) => sel.includes(spec.accessor!(row)));
    out = out.filter((row) => pred(row, selected));
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
