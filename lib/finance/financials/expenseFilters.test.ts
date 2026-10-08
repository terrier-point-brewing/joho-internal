import { describe, it, expect } from "vitest";
import { applyExpenseStatementFilters } from "./expenseFilters";

/** Records every filter call and returns itself, mimicking a PostgREST builder. */
function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const q = {
    calls,
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
  });

  it("counts cleared card/bank rows AND paid bills/reimbursements when cashOnly is true", () => {
    const q = recorder();
    applyExpenseStatementFilters(q, true);
    // Upper-case CLEARED: the expenses_state_upper_check CHECK constraint
    // guarantees the column's casing. settled_at is what admits a paid Ramp
    // bill or reimbursement, whose state is PAID / REIMBURSED -- without it
    // rent and every supplier bill vanish from the cash-flow statement.
    expect(q.calls).toContainEqual(["or", "state.eq.CLEARED,settled_at.not.is.null"]);
  });

  it("returns the builder so it stays chainable", () => {
    const q = recorder();
    expect(applyExpenseStatementFilters(q, false)).toBe(q);
  });
});
