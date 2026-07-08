import { describe, it, expect } from "vitest";
import {
  PRODUCTION_INVENTORY_ACCOUNT_NUMBERS,
  isProductionInventoryAccount,
  selectInventoryAlerts,
  type InventoryAlertExpense,
} from "./inventoryAlerts";

describe("PRODUCTION_INVENTORY_ACCOUNT_NUMBERS", () => {
  it("is exactly 5110 and 5120", () => {
    expect([...PRODUCTION_INVENTORY_ACCOUNT_NUMBERS]).toEqual(["5110", "5120"]);
  });
});

describe("isProductionInventoryAccount", () => {
  it("matches alert accounts, trimming whitespace", () => {
    expect(isProductionInventoryAccount("5110")).toBe(true);
    expect(isProductionInventoryAccount(" 5120 ")).toBe(true);
  });
  it("rejects non-alert / missing accounts", () => {
    expect(isProductionInventoryAccount("6000")).toBe(false);
    expect(isProductionInventoryAccount(null)).toBe(false);
    expect(isProductionInventoryAccount(undefined)).toBe(false);
  });
});

describe("selectInventoryAlerts", () => {
  const row = (over: Partial<InventoryAlertExpense>): InventoryAlertExpense => ({
    id: "x",
    inventory_alert_dismissed: false,
    accounting_date: "2026-07-01",
    chart_of_accounts: { account_number: "5110" },
    ...over,
  });

  it("keeps un-dismissed expenses on alert accounts", () => {
    const out = selectInventoryAlerts([row({ id: "a" })]);
    expect(out.map((e) => e.id)).toEqual(["a"]);
  });

  it("drops dismissed expenses", () => {
    expect(selectInventoryAlerts([row({ id: "a", inventory_alert_dismissed: true })])).toEqual([]);
  });

  it("drops expenses on non-alert accounts", () => {
    expect(selectInventoryAlerts([row({ chart_of_accounts: { account_number: "6000" } })])).toEqual([]);
  });

  it("drops expenses with no chart_of_accounts", () => {
    expect(selectInventoryAlerts([row({ chart_of_accounts: null })])).toEqual([]);
  });

  it("sorts by accounting_date descending, nulls last", () => {
    const out = selectInventoryAlerts([
      row({ id: "old", accounting_date: "2026-01-01" }),
      row({ id: "nul", accounting_date: null }),
      row({ id: "new", accounting_date: "2026-07-01" }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["new", "old", "nul"]);
  });

  it("returns empty for empty input", () => {
    expect(selectInventoryAlerts([])).toEqual([]);
  });
});
