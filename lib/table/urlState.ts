import type { ControlsConfig, ControlsState, SortState } from "./types";

function parseSort(raw: string | null, fallback: SortState): SortState {
  if (!raw) return fallback;
  return raw.startsWith("-")
    ? { key: raw.slice(1), dir: "desc" }
    : { key: raw, dir: "asc" };
}

/** Read a ControlsState out of URL params, given the table's config. */
export function parseControlsState<T>(
  params: URLSearchParams,
  config: ControlsConfig<T>,
  prefix = "",
): ControlsState {
  const search: Record<string, string> = {};
  for (const spec of config.search ?? []) {
    const v = params.get(prefix + spec.param);
    if (v) search[spec.param] = v;
  }

  const filters: Record<string, string[]> = {};
  for (const spec of config.filters ?? []) {
    const v = params.get(prefix + spec.param);
    if (v) filters[spec.param] = v.split(",").filter(Boolean);
  }

  const sort = parseSort(params.get(prefix + "sort"), config.sort?.default ?? null);

  return { search, filters, sort };
}

/** Serialize a ControlsState onto a clone of `base`, touching only owned params. */
export function serializeControlsState<T>(
  state: ControlsState,
  config: ControlsConfig<T>,
  base: URLSearchParams,
  prefix = "",
): URLSearchParams {
  const out = new URLSearchParams(base.toString());

  for (const spec of config.search ?? []) {
    const key = prefix + spec.param;
    const v = (state.search[spec.param] ?? "").trim();
    if (v) out.set(key, v);
    else out.delete(key);
  }

  for (const spec of config.filters ?? []) {
    const key = prefix + spec.param;
    const v = state.filters[spec.param] ?? [];
    if (v.length) out.set(key, v.join(","));
    else out.delete(key);
  }

  const sortKey = prefix + "sort";
  if (state.sort) out.set(sortKey, (state.sort.dir === "desc" ? "-" : "") + state.sort.key);
  else out.delete(sortKey);

  return out;
}

/** Count active search boxes + filter dimensions (drives the "Clear (N)" button). */
export function countActiveControls(state: ControlsState): number {
  const searches = Object.values(state.search).filter((v) => v.trim().length > 0).length;
  const filters = Object.values(state.filters).filter((v) => v.length > 0).length;
  return searches + filters;
}
