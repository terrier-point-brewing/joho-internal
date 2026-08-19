import { describe, it, expect } from "vitest";
import { isEmptyShellOrder } from "./emptyOrders";

describe("isEmptyShellOrder", () => {
  it("catches a cash-drawer open — a NO_SALE tender with nothing rung up", () => {
    expect(
      isEmptyShellOrder({ total_money: { amount: 0, currency: "USD" } }),
    ).toBe(true);
  });

  it("catches an abandoned ticket, which carries no money fields at all", () => {
    expect(isEmptyShellOrder({})).toBe(true);
    expect(isEmptyShellOrder({ line_items: [] })).toBe(true);
  });

  it("spares any order with a line item on it, even a $0 comp", () => {
    expect(
      isEmptyShellOrder({
        line_items: [{ uid: "li1", name: "Comped Pint", quantity: "1" }],
        total_money: { amount: 0, currency: "USD" },
      }),
    ).toBe(false);
  });

  // The money test is what makes this safe to skip in the sync: a real sale
  // that Square later cancels keeps its money, so it can never match here.
  it("spares a money-bearing order even with no line items", () => {
    expect(isEmptyShellOrder({ total_money: { amount: 700, currency: "USD" } })).toBe(false);
    expect(isEmptyShellOrder({ total_tax_money: { amount: 51, currency: "USD" } })).toBe(false);
    expect(isEmptyShellOrder({ total_tip_money: { amount: 200, currency: "USD" } })).toBe(false);
  });
});
