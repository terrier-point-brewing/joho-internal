import { describe, it, expect } from "vitest";
import { applyExpenseStatementFilters } from "./expenseFilters";

/** Records every filter call and returns itself, mimicking a PostgREST builder. */
function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const q = {
    calls,
    filter(...args: unknown[]) { calls.push(["filter", ...args]); return q; },
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
    expect(q.calls.some(([fn]) => fn === "filter")).toBe(false);
  });

  it("matches settled rows on an exact upper-case CLEARED when cashOnly is true", () => {
    const q = recorder();
    applyExpenseStatementFilters(q, true);
    // Exact equality, and upper-case: the expenses_state_upper_check CHECK
    // constraint guarantees the column's casing. A lower-case literal would now
    // match nothing and silently empty the cash-flow statement.
    expect(q.calls).toContainEqual(["filter", "state", "eq", "CLEARED"]);
    expect(q.calls.some(([fn]) => fn === "or")).toBe(false);
    expect(q.calls.some(([fn]) => fn === "ilike")).toBe(false);
  });

  it("returns the builder so it stays chainable", () => {
    const q = recorder();
    expect(applyExpenseStatementFilters(q, false)).toBe(q);
  });
});
