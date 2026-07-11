import { describe, it, expect } from "vitest";
import { resolveBankBackfill } from "./autoMap";

describe("resolveBankBackfill", () => {
  const rules = new Map<string, string>([["gusto", "coa-payroll"]]);

  it("maps an unmapped row whose counterparty has a rule", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", counterparty_key: "gusto", mapping_source: "unmapped", chart_of_accounts_id: null }],
      rules,
    );
    expect(out).toEqual([{ id: "r1", chart_of_accounts_id: "coa-payroll" }]);
  });

  it("never overwrites a manual pin", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", counterparty_key: "gusto", mapping_source: "manual", chart_of_accounts_id: "coa-x" }],
      rules,
    );
    expect(out).toEqual([]);
  });

  it("never overwrites an already-mapped row (fill-nulls-only)", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", counterparty_key: "gusto", mapping_source: "rule", chart_of_accounts_id: "coa-old" }],
      rules,
    );
    expect(out).toEqual([]);
  });

  it("skips rows whose counterparty has no rule", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", counterparty_key: "unknown", mapping_source: "unmapped", chart_of_accounts_id: null }],
      rules,
    );
    expect(out).toEqual([]);
  });

  it("skips rows with a null counterparty_key", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", counterparty_key: null, mapping_source: "unmapped", chart_of_accounts_id: null }],
      rules,
    );
    expect(out).toEqual([]);
  });
});
