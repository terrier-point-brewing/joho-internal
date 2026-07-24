import { describe, it, expect } from "vitest";
import { applyExpenseStatementFilters } from "./expenseFilters";

/** Records every filter call and returns itself, mimicking a PostgREST builder. */
function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const q = {
    calls,
    ilike(...args: unknown[]) { calls.push(["ilike", ...args]); return q; },
    or(...args: unknown[]) { calls.push(["or", ...args]); return q; },
    is(...args: unknown[]) { calls.push(["is", ...args]); return q; },
  };
  return q;
}

describe("applyExpenseStatementFilters", () => {
  it("excludes manually-excluded rows on the accrual path", () => {
    const q = recorder();
    applyExpenseStatementFilters(q, false);
    expect(q.calls).toContainEqual(["is", "excluded_at", null]);
  });

  it("excludes manually-excluded rows on the cash path too", () => {
    const q = recorder();
    applyExpenseStatementFilters(q, true);
    expect(q.calls).toContainEqual(["is", "excluded_at", null]);
  });

  it("keeps the accrual state filter when cashOnly is false", () => {
    const q = recorder();
    applyExpenseStatementFilters(q, false);
    expect(q.calls).toContainEqual(["or", "state.is.null,state.neq.DECLINED"]);
    expect(q.calls.some(([fn]) => fn === "ilike")).toBe(false);
  });

  it("uses the case-insensitive cleared filter when cashOnly is true", () => {
    const q = recorder();
    applyExpenseStatementFilters(q, true);
    expect(q.calls).toContainEqual(["ilike", "state", "cleared"]);
    expect(q.calls.some(([fn]) => fn === "or")).toBe(false);
  });

  it("returns the builder so it stays chainable", () => {
    const q = recorder();
    expect(applyExpenseStatementFilters(q, false)).toBe(q);
  });
});
