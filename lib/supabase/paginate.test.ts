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
