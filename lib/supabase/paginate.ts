/**
 * Shared Supabase pagination helper.
 *
 * PostgREST silently truncates an unpaginated `select` at its `db-max-rows`
 * cap (1000 rows on this project) with NO error — any aggregate built over such
 * a query is quietly wrong once the result set exceeds the cap. `fetchAllRows`
 * pages through the full result set so callers never depend on staying under
 * that limit.
 *
 * This lived in `lib/finance/financials/fetchSources.ts` (where the
 * financials-parity harness first caught the truncation); it was moved here so
 * any feature that aggregates a Supabase query can reuse it instead of
 * reinventing the un-paginated select the cap punishes.
 */
export const PAGE_SIZE = 1000;

/**
 * Pages through a Supabase select in chunks of PAGE_SIZE. Loops `.range()`
 * until a page returns fewer rows than the page size.
 *
 * `build` must return a FRESH query builder (filters + a stable `.order()`
 * already applied, no `.range()` yet) on every call — Supabase builders are
 * single-use, so the same instance can't be re-ranged across pages. A stable
 * order is required for `.range()` to page correctly (unordered pages can
 * overlap or skip rows); call sites are responsible for adding it.
 *
 * `pageSize` defaults to PAGE_SIZE; overridable for tests only (a fake pager
 * driven by a smaller page size exercises the same multi-page loop without
 * needing 1000+ fixture rows).
 */
export async function fetchAllRows<T>(
  build: () => { range: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  pageSize: number = PAGE_SIZE,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}
