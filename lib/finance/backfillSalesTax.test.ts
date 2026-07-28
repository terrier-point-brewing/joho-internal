import { describe, it, expect } from "vitest";
import { planPosNetSalesFix, planInvoiceUidRepair } from "./backfillSalesTax";

describe("planPosNetSalesFix", () => {
  it("corrects a tax-inclusive row to gross - discount", () => {
    const plan = planPosNetSalesFix([
      { id: "a", gross_sales_cents: 1200, discount_cents: 0, tax_cents: 99, net_sales_cents: 1299, month: "2026-06" },
    ]);
    expect(plan.updates).toEqual([{ id: "a", net_sales_cents: 1200 }]);
    expect(plan.centsRemoved).toBe(99);
    expect(plan.byMonth).toEqual({ "2026-06": 99 });
    expect(plan.skippedIdentityMismatch).toBe(0);
  });

  it("is idempotent — an already-corrected row is skipped", () => {
    const plan = planPosNetSalesFix([
      { id: "a", gross_sales_cents: 1200, discount_cents: 0, tax_cents: 99, net_sales_cents: 1200, month: "2026-06" },
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.centsRemoved).toBe(0);
    expect(plan.skippedIdentityMismatch).toBe(0);
  });

  it("refuses a row that violates net = gross - discount + tax", () => {
    const plan = planPosNetSalesFix([
      { id: "bad", gross_sales_cents: 1000, discount_cents: 0, tax_cents: 50, net_sales_cents: 9999, month: "2026-06" },
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.skippedIdentityMismatch).toBe(1);
  });

  it("accumulates removed tax per month", () => {
    const plan = planPosNetSalesFix([
      { id: "a", gross_sales_cents: 100, discount_cents: 0, tax_cents: 7, net_sales_cents: 107, month: "2026-05" },
      { id: "b", gross_sales_cents: 200, discount_cents: 0, tax_cents: 14, net_sales_cents: 214, month: "2026-06" },
      { id: "c", gross_sales_cents: 300, discount_cents: 0, tax_cents: 21, net_sales_cents: 321, month: "2026-06" },
    ]);
    expect(plan.byMonth).toEqual({ "2026-05": 7, "2026-06": 35 });
    expect(plan.centsRemoved).toBe(42);
  });
});

describe("planInvoiceUidRepair", () => {
  const rawLines = [
    { uid: "u-a", name: "Packaging Fee", gross_sales_money: { amount: 100 }, total_discount_money: { amount: 0 }, total_tax_money: { amount: 0 } },
    { uid: "u-excise", name: "Barrel Excise Tax", gross_sales_money: { amount: 500 }, total_discount_money: { amount: 0 }, total_tax_money: { amount: 0 } },
    { uid: "u-c", name: "CO2 Refill", gross_sales_money: { amount: 900 }, total_discount_money: { amount: 0 }, total_tax_money: { amount: 65 } },
  ];
  const carveOuts = [500];

  it("maps sort_order to the right uid across a skipped excise line", () => {
    const res = planInvoiceUidRepair(
      rawLines, carveOuts,
      [
        { id: "r0", sort_order: 0, gross_sales_cents: 100, discount_cents: 0, tax_cents: 0, square_line_item_uid: "u-a" },
        { id: "r1", sort_order: 1, gross_sales_cents: 900, discount_cents: 0, tax_cents: 65, square_line_item_uid: "u-excise" },
      ],
    );
    expect(res.ok).toBe(true);
    expect(res.updates).toEqual([{ id: "r1", square_line_item_uid: "u-c" }]);
    expect(res.uidByRowId).toEqual({ r0: "u-a", r1: "u-c" });
  });

  it("refuses the invoice when a row's money triple does not match its mapped line", () => {
    const res = planInvoiceUidRepair(
      rawLines, carveOuts,
      [{ id: "r0", sort_order: 0, gross_sales_cents: 777, discount_cents: 0, tax_cents: 0, square_line_item_uid: null }],
    );
    expect(res.ok).toBe(false);
    expect(res.updates).toEqual([]);
  });
});
