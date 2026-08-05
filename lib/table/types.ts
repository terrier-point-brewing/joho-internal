export type SortDir = "asc" | "desc";

/** null = no active sort — applyControls leaves rows in source order. The config default (ControlsConfig.sort.default) is applied upstream at the URL-parse layer, which seeds this to the default when the sort param is absent. */
export type SortState = { key: string; dir: SortDir } | null;

/** One free-text search box. An accessor returning an array = identity-blend
 *  (OR across those fields within this single box). */
export interface SearchSpec<T> {
  /** URL param key, e.g. "q" or "q_recipe". */
  param: string;
  accessor: (row: T) => string | (string | null | undefined)[];
  /** Optional second pass for rows that are containers of sub-items (an invoice
   *  card of product lines, say). A surviving row is replaced by a copy holding
   *  only the sub-items that matched, so the row can't report totals the search
   *  didn't ask for. The engine hands in its own `matches`, which is the exact
   *  comparison it used against `accessor` — narrowing and matching therefore
   *  cannot drift apart, and a row that survived can never narrow to empty as
   *  long as both read the same field. */
  narrow?: (row: T, matches: (text: string | null | undefined) => boolean) => T;
}

/** One categorical filter dimension. Provide `matches` for group/predicate
 *  filters that can't be expressed as single-value equality; otherwise the
 *  engine uses `selected.includes(accessor(row))`. */
export interface FilterSpec<T> {
  /** URL param key, e.g. "status" or "channel". */
  param: string;
  accessor?: (row: T) => string;
  /** true = multiple values may be selected (OR within the dimension). */
  multi?: boolean;
  /** Custom membership test; overrides accessor-equality when present. */
  matches?: (row: T, selected: string[]) => boolean;
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
