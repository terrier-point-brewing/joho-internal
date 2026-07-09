export type SortDir = "asc" | "desc";

/** null = no active sort — applyControls leaves rows in source order. The config default (ControlsConfig.sort.default) is applied upstream at the URL-parse layer, which seeds this to the default when the sort param is absent. */
export type SortState = { key: string; dir: SortDir } | null;

/** One free-text search box. An accessor returning an array = identity-blend
 *  (OR across those fields within this single box). */
export interface SearchSpec<T> {
  /** URL param key, e.g. "q" or "q_recipe". */
  param: string;
  accessor: (row: T) => string | (string | null | undefined)[];
}

/** One categorical filter dimension. */
export interface FilterSpec<T> {
  /** URL param key, e.g. "status" or "channel". */
  param: string;
  accessor: (row: T) => string;
  /** true = multiple values may be selected (OR within the dimension). */
  multi?: boolean;
}

/** One sortable column. */
export interface SortSpec<T> {
  /** Sort key, matches SortState.key and the `sort` URL param value. */
  key: string;
  accessor: (row: T) => unknown;
}

export interface ControlsConfig<T> {
  search?: SearchSpec<T>[];
  filters?: FilterSpec<T>[];
  sort?: { columns: SortSpec<T>[]; default?: SortState };
}

export interface ControlsState {
  /** param -> query text. */
  search: Record<string, string>;
  /** param -> selected values. Empty array = no filter (All). */
  filters: Record<string, string[]>;
  sort: SortState;
}
