import { describe, it, expect } from "vitest";
import { isTaproomSalesAccount, proratedTaproomManualSalesCents } from "./manualSalesEntries";

describe("isTaproomSalesAccount", () => {
  it("accepts 4000, the 41xx taproom subtree and 4910 taproom discounts", () => {
    for (const n of ["4000", "4100", "4111", "4160", "4910"]) expect(isTaproomSalesAccount(n)).toBe(true);
  });
  it("rejects wholesale, contract brewing, COGS, expenses, liabilities and null", () => {
    for (const n of ["4200", "4310", "4400", "4920", "5110", "6110", "2220", null, undefined, ""]) {
      expect(isTaproomSalesAccount(n)).toBe(false);
    }
  });
});

describe("proratedTaproomManualSalesCents", () => {
  // The nine GL corrections dated 2026-10-01 that inflated Oct 1–4 by $2,516.84.
  const octCorrections = [
    { startDate: "2026-10-01", endDate: "2026-10-01", amountCents: 173388, accountNumber: "6110" },
    { startDate: "2026-10-01", endDate: "2026-10-01", amountCents: 158856, accountNumber: "6110" },
    { startDate: "2026-10-01", endDate: "2026-10-01", amountCents: 56455, accountNumber: "5110" },
    { startDate: "2026-10-01", endDate: "2026-10-01", amountCents: 116890, accountNumber: "5110" },
    { startDate: "2026-10-01", endDate: "2026-10-01", amountCents: 14632, accountNumber: "5230" },
    { startDate: "2026-10-01", endDate: "2026-10-01", amountCents: -174450, accountNumber: "4310" },
    { startDate: "2026-10-01", endDate: "2026-10-01", amountCents: -40480, accountNumber: "4320" },
    { startDate: "2026-10-01", endDate: "2026-10-01", amountCents: -42007, accountNumber: "4330" },
    { startDate: "2026-10-01", endDate: "2026-10-01", amountCents: -11600, accountNumber: "4340" },
  ];

  it("ignores GL corrections on non-taproom accounts", () => {
    expect(proratedTaproomManualSalesCents(octCorrections, "2026-10-01", "2026-10-04")).toBe(0);
  });

  it("prorates a taproom entry by day overlap", () => {
    const entries = [
      // 30 days, $300 → $10/day; window covers Apr 21–30 = 10 days.
      { startDate: "2026-04-01", endDate: "2026-04-30", amountCents: 30000, accountNumber: "4000" },
    ];
    expect(proratedTaproomManualSalesCents(entries, "2026-04-21", "2026-05-03")).toBe(10000);
  });

  it("sums only the taproom accounts when entries are mixed", () => {
    const entries = [
      { startDate: "2026-05-22", endDate: "2026-05-22", amountCents: 169278, accountNumber: "4000" },
      { startDate: "2026-05-22", endDate: "2026-05-22", amountCents: 169278, accountNumber: "2220" },
      { startDate: "2026-05-04", endDate: "2026-05-31", amountCents: -1066264, accountNumber: "6110" },
    ];
    expect(proratedTaproomManualSalesCents(entries, "2026-05-18", "2026-05-24")).toBe(169278);
  });

  it("contributes nothing outside the window", () => {
    const entries = [{ startDate: "2026-06-01", endDate: "2026-06-01", amountCents: 500, accountNumber: "4110" }];
    expect(proratedTaproomManualSalesCents(entries, "2026-06-02", "2026-06-08")).toBe(0);
  });
});
