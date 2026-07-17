import { describe, it, expect } from "vitest";
import { resolveLineItemCoa, type LineItemCoa } from "./syncSquareInvoices";

const NONE: LineItemCoa = { chart_of_accounts_id: null };

describe("resolveLineItemCoa", () => {
  it("keeps an existing manual mapping even when the variation prefill is null", () => {
    const existing: LineItemCoa = { chart_of_accounts_id: "COA_MANUAL" };
    expect(resolveLineItemCoa(existing, NONE)).toEqual(existing);
  });

  it("keeps an existing mapping even when the variation prefill differs", () => {
    const existing: LineItemCoa = { chart_of_accounts_id: "COA_MANUAL" };
    const prefill: LineItemCoa = { chart_of_accounts_id: "COA_DEFAULT" };
    expect(resolveLineItemCoa(existing, prefill)).toEqual({ chart_of_accounts_id: "COA_MANUAL" });
  });

  it("prefills a brand-new line item (no existing row) from the variation", () => {
    const prefill: LineItemCoa = { chart_of_accounts_id: "COA_DEFAULT" };
    expect(resolveLineItemCoa(undefined, prefill)).toEqual(prefill);
  });

  it("prefills a still-null existing item from the variation", () => {
    const prefill: LineItemCoa = { chart_of_accounts_id: "COA_DEFAULT" };
    expect(resolveLineItemCoa(NONE, prefill)).toEqual(prefill);
  });
});
