"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { applyControls } from "@/lib/table/applyControls";
import {
  parseControlsState,
  serializeControlsState,
  countActiveControls,
} from "@/lib/table/urlState";
import type { ControlsConfig, ControlsState, SortDir, SortState } from "@/lib/table/types";

export interface TableControls<T> {
  /** rows after search + filter + sort */
  rows: T[];
  search: Record<string, string>;
  filters: Record<string, string[]>;
  sort: SortState;
  setSearch: (param: string, value: string) => void;
  setFilter: (param: string, values: string[]) => void;
  /** toggle a column: inactive -> asc, asc -> desc, desc -> asc */
  toggleSort: (key: string) => void;
  reset: () => void;
  activeCount: number;
}

/**
 * URL-synced search/filter/sort state for a table. All derivation is delegated
 * to the pure functions in lib/table; this hook only bridges them to the URL.
 */
export function useTableControls<T>(
  rows: T[],
  config: ControlsConfig<T>,
  opts?: { prefix?: string },
): TableControls<T> {
  const prefix = opts?.prefix ?? "";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = useMemo<ControlsState>(
    () => parseControlsState(new URLSearchParams(searchParams.toString()), config, prefix),
    [searchParams, config, prefix],
  );

  const push = useCallback(
    (next: ControlsState) => {
      const base = new URLSearchParams(searchParams.toString());
      const sp = serializeControlsState(next, config, base, prefix);
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams, config, prefix],
  );

  const setSearch = useCallback(
    (param: string, value: string) => push({ ...state, search: { ...state.search, [param]: value } }),
    [push, state],
  );

  const setFilter = useCallback(
    (param: string, values: string[]) => push({ ...state, filters: { ...state.filters, [param]: values } }),
    [push, state],
  );

  const toggleSort = useCallback(
    (key: string) => {
      const dir: SortDir = state.sort?.key === key && state.sort.dir === "asc" ? "desc" : "asc";
      push({ ...state, sort: { key, dir } });
    },
    [push, state],
  );

  const reset = useCallback(
    () => push({ search: {}, filters: {}, sort: config.sort?.default ?? null }),
    [push, config],
  );

  const applied = useMemo(() => applyControls(rows, config, state), [rows, config, state]);
  const activeCount = countActiveControls(state);

  return {
    rows: applied,
    search: state.search,
    filters: state.filters,
    sort: state.sort,
    setSearch,
    setFilter,
    toggleSort,
    reset,
    activeCount,
  };
}
