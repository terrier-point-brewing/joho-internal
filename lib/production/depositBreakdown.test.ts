import { describe, it, expect } from "vitest";
import { buildBreakdownLines, type BreakdownInput } from "./depositBreakdown";

const mk = (name: string, weight: number): BreakdownInput => ({
  ingredient_id: name, name, unit: "lb", quantity_per_bbl: 1, cost_per_unit_usd: weight, weight,
});

describe("buildBreakdownLines", () => {
  it("scales line totals to sum exactly to the invoice total", () => {
    const lines = buildBreakdownLines([mk("a", 1), mk("b", 1), mk("c", 1)], 100);
    expect(lines.map((l) => l.line_total_cents)).toEqual([34, 33, 33]);
    expect(lines.reduce((s, l) => s + l.line_total_cents, 0)).toBe(100);
  });

  it("distributes leftover cents by largest fractional remainder", () => {
    // weights 1,1,1 over 10 cents -> 3.33 each; remainders equal -> first rows get the extra
    const lines = buildBreakdownLines([mk("a", 1), mk("b", 1), mk("c", 1)], 10);
    expect(lines.reduce((s, l) => s + l.line_total_cents, 0)).toBe(10);
    expect(lines[0].line_total_cents).toBe(4);
  });

  it("preserves proportions for unequal weights", () => {
    const lines = buildBreakdownLines([mk("a", 3), mk("b", 1)], 100);
    expect(lines[0].line_total_cents).toBe(75);
    expect(lines[1].line_total_cents).toBe(25);
    expect(lines.reduce((s, l) => s + l.line_total_cents, 0)).toBe(100);
  });

  it("assigns sort_order by input order and carries frozen fields", () => {
    const lines = buildBreakdownLines([mk("a", 1), mk("b", 1)], 100);
    expect(lines[0].sort_order).toBe(0);
    expect(lines[1].sort_order).toBe(1);
    expect(lines[0].ingredient_name).toBe("a");
  });

  it("returns no lines when total weight is zero", () => {
    expect(buildBreakdownLines([mk("a", 0), mk("b", 0)], 100)).toEqual([]);
  });
});
