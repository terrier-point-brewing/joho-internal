// Covers fetchAllRows -- the shared pagination helper that callers (financials
// per-source fetches, the NC DOR taxable-base query, etc.) route through to
// avoid PostgREST's silent 1000-row cap (first caught by the financials parity
// harness, see task-8-report.md).
import { describe, it, expect } from "vitest";
import { fetchAllRows } from "./paginate";

/** Fake query builder: `.range(from, to)` slices a fixed in-memory row set, mirroring Supabase's inclusive-range semantics. */
function fakeBuilder<T>(allRows: T[], onCall?: (from: number, to: number) => void) {
  return () => ({
    range: async (from: number, to: number) => {
      onCall?.(from, to);
      return { data: allRows.slice(from, to + 1), error: null };
    },
  });
}

describe("fetchAllRows", () => {
  it("accumulates rows across multiple full pages plus a short final page", async () => {
    const allRows = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const result = await fetchAllRows<{ id: number }>(fakeBuilder(allRows), 2);
    expect(result).toEqual(allRows);
  });

  it("returns everything in one page when the data set is smaller than the page size", async () => {
    const allRows = [{ id: 1 }, { id: 2 }];
    const calls: [number, number][] = [];
    const result = await fetchAllRows<{ id: number }>(fakeBuilder(allRows, (f, t) => calls.push([f, t])), 10);
    expect(result).toEqual(allRows);
    expect(calls).toEqual([[0, 9]]);
  });

  it("issues one extra (empty) request when the final page exactly fills the page size", async () => {
    // This is standard .range()-pagination behavior, not a bug: with only
    // {from,to} to go on, the loop can't tell "exactly full" from "more
    // data exists" without making the next request and seeing it come back
    // short/empty.
    const allRows = [{ id: 1 }, { id: 2 }];
    const calls: [number, number][] = [];
    const result = await fetchAllRows<{ id: number }>(fakeBuilder(allRows, (f, t) => calls.push([f, t])), 2);
    expect(result).toEqual(allRows);
    expect(calls).toEqual([[0, 1], [2, 3]]);
  });

  it("preserves row order across page boundaries", async () => {
    const allRows = Array.from({ length: 7 }, (_, i) => ({ id: i, label: `row-${i}` }));
    const result = await fetchAllRows<{ id: number; label: string }>(fakeBuilder(allRows), 3);
    expect(result.map((r) => r.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("propagates a query error instead of silently truncating", async () => {
    const build = () => ({
      range: async () => ({ data: null, error: { message: "connection reset" } }),
    });
    await expect(fetchAllRows<unknown>(build, 10)).rejects.toThrow("connection reset");
  });

  it("returns an empty array when the source has no rows", async () => {
    const result = await fetchAllRows<{ id: number }>(fakeBuilder<{ id: number }>([]), 10);
    expect(result).toEqual([]);
  });
});

// The concurrent path exists only to trade sequential round trips for parallel
// ones; every test here is really asking the same question -- does it return
// exactly what the sequential loop returns?
describe("fetchAllRows with concurrency", () => {
  it("returns the same rows in the same order as the sequential loop", async () => {
    const allRows = Array.from({ length: 23 }, (_, i) => ({ id: i }));
    const sequential = await fetchAllRows<{ id: number }>(fakeBuilder(allRows), 4);
    const concurrent = await fetchAllRows<{ id: number }>(fakeBuilder(allRows), 4, 3);
    expect(concurrent).toEqual(sequential);
    expect(concurrent).toEqual(allRows);
  });

  it("fetches a whole batch of pages at once and keeps going past it", async () => {
    const allRows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const calls: [number, number][] = [];
    const result = await fetchAllRows<{ id: number }>(fakeBuilder(allRows, (f, t) => calls.push([f, t])), 2, 3);
    expect(result).toEqual(allRows);
    // Two batches of three disjoint windows. The second batch's last page runs
    // past the end and comes back short, which is what stops the loop.
    expect(calls).toEqual([
      [0, 1], [2, 3], [4, 5],
      [6, 7], [8, 9], [10, 11],
    ]);
  });

  it("discards the overshoot pages past the end of the data", async () => {
    const allRows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = await fetchAllRows<{ id: number }>(fakeBuilder(allRows), 2, 8);
    expect(result).toEqual(allRows);
  });

  it("throws on a failed page rather than returning the batch's surviving rows", async () => {
    // A short answer assembled around a failed page is precisely the silent
    // truncation this module exists to prevent, so the error wins over the rows
    // that did come back.
    let call = 0;
    const build = () => ({
      range: async (from: number, to: number) => {
        const failing = call++ === 1;
        return failing
          ? { data: null, error: { message: "connection reset" } }
          : { data: [{ id: from }, { id: to }], error: null };
      },
    });
    await expect(fetchAllRows<{ id: number }>(build, 2, 3)).rejects.toThrow("connection reset");
  });

  it("returns an empty array when the source has no rows", async () => {
    const result = await fetchAllRows<{ id: number }>(fakeBuilder<{ id: number }>([]), 10, 4);
    expect(result).toEqual([]);
  });
});
