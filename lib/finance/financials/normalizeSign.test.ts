import { describe, it, expect } from "vitest";
import { normalizeSignedCents } from "./normalizeSign";

describe("normalizeSignedCents", () => {
  it("POS income (unsigned positive input) normalizes to positive", () => {
    expect(normalizeSignedCents(5000, "revenue", "pos")).toBe(5000);
  });

  it("invoice income (unsigned positive input) normalizes to positive", () => {
    expect(normalizeSignedCents(12000, "revenue", "invoice")).toBe(12000);
  });

  it("expense (already-signed negative input) normalizes to negative", () => {
    expect(normalizeSignedCents(-2500, "expenses", "expense")).toBe(-2500);
  });

  it("expense mapped to cogs (already-signed negative input) normalizes to negative", () => {
    expect(normalizeSignedCents(-1800, "cogs", "expense")).toBe(-1800);
  });

  it("square_refunds contra-revenue (unsigned positive magnitude) normalizes to negative", () => {
    expect(normalizeSignedCents(750, "revenue", "refund")).toBe(-750);
  });

  it("bank interest_income (already-signed positive input) normalizes to positive", () => {
    expect(normalizeSignedCents(300, "other_income", "bank")).toBe(300);
  });

  it("bank outflow mapped to expenses (already-signed negative input) normalizes to negative", () => {
    expect(normalizeSignedCents(-4200, "expenses", "bank")).toBe(-4200);
  });

  it("reconciles unsigned-positive and already-signed conventions to the same normalized sign", () => {
    // POS/invoice arrive unsigned-positive; expense/bank arrive already-signed.
    // Same economic direction (a cost) must normalize to the same sign either way.
    const fromUnsigned = normalizeSignedCents(1000, "expenses", "invoice");
    const fromSigned = normalizeSignedCents(-1000, "expenses", "expense");
    expect(fromUnsigned).toBe(fromSigned);
    expect(fromUnsigned).toBe(-1000);
  });

  it("balance-sheet section (fixed_assets) normalizes to positive regardless of raw sign", () => {
    expect(normalizeSignedCents(-150000, "fixed_assets", "expense")).toBe(150000);
  });

  it("balance-sheet section (accounts payable) normalizes to negative", () => {
    expect(normalizeSignedCents(20000, "ap", "bank")).toBe(-20000);
  });

  it("other_expense (already-signed negative input, a spend) normalizes to negative", () => {
    expect(normalizeSignedCents(-900, "other_expense", "expense")).toBe(-900);
  });

  // ── C1 fix: expense/bank rows on a P&L section pass through their
  // cash-direction sign unchanged instead of being re-signed from the
  // section. A positive (credit/inflow) amount must offset cost / read as
  // income, not become -magnitude. See lib/finance/financials/normalizeSign.ts
  // header comment + Task 15 final review, finding C1.
  it("expense credit (already-signed positive input) mapped to expenses normalizes to positive, offsetting cost", () => {
    expect(normalizeSignedCents(1500, "expenses", "expense")).toBe(1500);
  });

  // "bank interest_income (already-signed positive input) normalizes to
  // positive" above already covers bank/other_income/positive-input.

  it("bank outflow mapped to a Balance Sheet section (fixed_assets) still normalizes to a positive asset (BS path unchanged)", () => {
    expect(normalizeSignedCents(-75000, "fixed_assets", "bank")).toBe(75000);
  });

  // ── Liability paydown fix: expense/bank rows on a Balance Sheet liability
  // section must reduce the liability on an outflow (negative raw), not grow
  // it. See lib/finance/financials/normalizeSign.ts header + Task 5.
  it("liability paydown (expense outflow) reduces an other_current_liabilities balance", () => {
    expect(normalizeSignedCents(-190000, "other_current_liabilities", "expense")).toBe(190000);
  });

  it("liability inflow (bank credit) increases an other_current_liabilities balance", () => {
    expect(normalizeSignedCents(50000, "other_current_liabilities", "bank")).toBe(-50000);
  });

  it("the NC DOR expense case: an outflow reduces the ap liability", () => {
    expect(normalizeSignedCents(-20000, "ap", "expense")).toBe(20000);
  });

  it("a tip_accrual on an other_current_liabilities account increases the liability", () => {
    expect(normalizeSignedCents(204354, "other_current_liabilities", "tip_accrual")).toBe(-204354);
  });

  it("asset case (expense outflow on fixed_assets) unchanged by the liability fix", () => {
    expect(normalizeSignedCents(-50000, "fixed_assets", "expense")).toBe(50000);
  });

  // ── Bank's own ledger (statementSection "bank") is a deliberate carve-out
  // from the liability fix: a ramp_bank_ledger row mapped back to the
  // checking account itself represents the cash balance's own delta, not
  // cash spent to acquire some OTHER asset/pay down a liability. The raw
  // cash-direction sign already equals the desired cashOnHandCents sign, so
  // it must not be flipped (unlike ar/other_current_assets/fixed_assets).
  it("a bank ledger deposit (inflow) mapped to the bank's own account increases cash on hand", () => {
    expect(normalizeSignedCents(500000, "bank", "bank")).toBe(500000);
  });

  // The "bank" section carve-out passes the raw cash-direction sign through
  // UNCHANGED (not magnitude): ramp_bank_ledger rows on "bank" ARE the cash
  // account's own ledger, so raw already expresses the balance delta. An
  // outflow (negative raw) must reduce cashOnHandCents, not inflate it --
  // see buildFinancials.ts's cashOnHandCents and normalizeSign.ts's header.
  it("a bank ledger withdrawal (outflow) mapped to the bank's own account normalizes to negative, reducing cash on hand", () => {
    expect(normalizeSignedCents(-75000, "bank", "expense")).toBe(-75000);
  });
});
