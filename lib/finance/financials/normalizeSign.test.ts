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

  it("other_expense normalizes to negative", () => {
    expect(normalizeSignedCents(900, "other_expense", "expense")).toBe(-900);
  });
});
