import { describe, it, expect } from "vitest";
import { isOrphanedFiling } from "./salesTaxFilings";

const ref = { party_key: "nc_dor_sales_use", party_label: "NC DOR", field_label: "Square General Sales Tax" };
const COA = "7643c7d2-e2c2-491b-b722-af9647edebb7";

describe("isOrphanedFiling", () => {
  it("flags a tax an active filing needs that was excluded here", () => {
    expect(isOrphanedFiling({ chart_of_accounts_id: COA, excluded: true, filing_refs: [ref] })).toBe(true);
  });

  it("flags a tax an active filing needs that has no liability account", () => {
    expect(isOrphanedFiling({ chart_of_accounts_id: null, excluded: false, filing_refs: [ref] })).toBe(true);
  });

  it("stays quiet when the tax is both mapped and not excluded", () => {
    expect(isOrphanedFiling({ chart_of_accounts_id: COA, excluded: false, filing_refs: [ref] })).toBe(false);
  });

  it("stays quiet for an excluded tax no filing depends on — that is a deliberate exclusion, not a break", () => {
    expect(isOrphanedFiling({ chart_of_accounts_id: null, excluded: true, filing_refs: [] })).toBe(false);
  });

  it("stays quiet for an unmapped tax no filing depends on", () => {
    expect(isOrphanedFiling({ chart_of_accounts_id: null, excluded: false, filing_refs: [] })).toBe(false);
  });
});
