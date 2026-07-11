import { describe, it, expect } from "vitest";
import { resolveBankBackfill, resolvePosBackfill, resolveInvoiceBackfill } from "./autoMap";

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

describe("resolvePosBackfill", () => {
  const coaByVar = new Map<string, string>([["v1", "coa-beer"]]);

  it("maps unmapped line items whose variation has a mapping", () => {
    const out = resolvePosBackfill([{ id: "li1", square_variation_id: "v1" }], coaByVar);
    expect(out).toEqual([{ id: "li1", chart_of_accounts_id: "coa-beer" }]);
  });

  it("skips items with no variation or no mapping", () => {
    const out = resolvePosBackfill(
      [{ id: "li1", square_variation_id: null }, { id: "li2", square_variation_id: "vX" }],
      coaByVar,
    );
    expect(out).toEqual([]);
  });
});

describe("resolveInvoiceBackfill", () => {
  const byDesc = new Map<string, string>([["hazy ipa — 1/6 bbl", "coa-dist"]]);

  it("maps an unmapped item by lowercased description", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", description: "Hazy IPA — 1/6 BBL", chart_of_accounts_id: null }],
      byDesc,
    );
    expect(out).toEqual([{ id: "il1", chart_of_accounts_id: "coa-dist" }]);
  });

  it("never overwrites an already-mapped item", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", description: "Hazy IPA — 1/6 BBL", chart_of_accounts_id: "coa-x" }],
      byDesc,
    );
    expect(out).toEqual([]);
  });

  it("skips items whose description has no match", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", description: "Mystery", chart_of_accounts_id: null }],
      byDesc,
    );
    expect(out).toEqual([]);
  });

  it("maps by catalog variation id (primary) even when the description does not match", () => {
    const byVar = new Map<string, string>([["VAR1", "coa-var"]]);
    const out = resolveInvoiceBackfill(
      [{ id: "il1", description: "Packaging Fee", square_catalog_variation_id: "VAR1", chart_of_accounts_id: null }],
      byDesc,
      byVar,
    );
    expect(out).toEqual([{ id: "il1", chart_of_accounts_id: "coa-var" }]);
  });

  it("prefers the variation match over a conflicting description match", () => {
    const byVar = new Map<string, string>([["VAR1", "coa-var"]]);
    const out = resolveInvoiceBackfill(
      [{ id: "il1", description: "Hazy IPA — 1/6 BBL", square_catalog_variation_id: "VAR1", chart_of_accounts_id: null }],
      byDesc,
      byVar,
    );
    expect(out).toEqual([{ id: "il1", chart_of_accounts_id: "coa-var" }]);
  });

  it("falls back to description when the line has no variation id", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", description: "Hazy IPA — 1/6 BBL", square_catalog_variation_id: null, chart_of_accounts_id: null }],
      byDesc,
      new Map(),
    );
    expect(out).toEqual([{ id: "il1", chart_of_accounts_id: "coa-dist" }]);
  });
});
