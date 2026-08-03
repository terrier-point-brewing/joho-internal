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
 * How many pages a `concurrency`-enabled caller asks for at once.
 *
 * The cap is a server-side PostgREST setting, not something a client can raise:
 * `.range(0, 9999)` still comes back with exactly 1000 rows. So a large table is
 * always N round trips, and doing them one after another makes latency — not
 * data volume — the cost. Measured against pos_line_items (5,210 rows, 6 pages):
 * 840ms sequential, 317ms with the pages in flight together.
 *
 * Eight is chosen to cover the current worst case in a single batch while
 * staying well inside PostgREST's connection pool. Overshoot is cheap: the
 * pages past the end return empty and are discarded.
 */
export const PAGE_CONCURRENCY = 8;

type PageBuilder = () => {
  range: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

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
 *
 * `concurrency` defaults to 1 — one page at a time, exactly as this has always
 * behaved. Raising it fetches that many pages together; see
 * `fetchAllRowsConcurrent` for what that is and is not safe for.
 */
export async function fetchAllRows<T>(
  build: PageBuilder,
  pageSize: number = PAGE_SIZE,
  concurrency: number = 1,
): Promise<T[]> {
  if (concurrency > 1) return fetchAllRowsConcurrent<T>(build, pageSize, concurrency);

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

/**
 * The same paging, with `concurrency` pages in flight at once.
 *
 * Returns exactly what the sequential loop returns, in exactly the same order:
 * page boundaries are computed up front from `pageSize`, so the batch is a set
 * of disjoint `.range()` windows reassembled in index order, and the loop still
 * stops at the first page that comes back short.
 *
 * ── Why the speculative batch, and not a count first ─────────────────────────
 * Knowing the page count needs `{ count: "exact", head: true }`, which means a
 * round trip before any data AND a second query shape the `build` contract
 * above does not describe. Asking for a batch and throwing away the pages past
 * the end costs one empty response each and keeps `build` as it is.
 *
 * ── What this is not safe for ────────────────────────────────────────────────
 * Concurrent pages are read at slightly different instants, so a table being
 * written to underneath can shift rows across a page boundary. That is a real
 * risk for a live-mutating feed and not one for the from-inception financial
 * reads this exists for, which run against tables written by nightly syncs. Do
 * not raise `concurrency` on a query whose rows are being inserted as it runs;
 * the sequential default has the same exposure but a narrower window.
 */
async function fetchAllRowsConcurrent<T>(build: PageBuilder, pageSize: number, concurrency: number): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const batch = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        build().range(from + i * pageSize, from + (i + 1) * pageSize - 1),
      ),
    );

    // Every error in the batch is surfaced before any row is kept: a partial
    // result assembled around a failed page is a silently short answer, which
    // is the exact failure this module exists to prevent.
    for (const { error } of batch) if (error) throw new Error(error.message);

    let reachedEnd = false;
    for (const { data } of batch) {
      const rows = (data ?? []) as T[];
      out.push(...rows);
      if (rows.length < pageSize) {
        reachedEnd = true;
        break;
      }
    }
    if (reachedEnd) return out;
    from += concurrency * pageSize;
  }
}
