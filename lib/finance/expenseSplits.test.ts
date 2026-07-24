import { describe, it, expect } from "vitest";
import { validateManualSplit, splitRemainderCents } from "./expenseSplits";

const line = (chartOfAccountsId: string, amountCents: number) => ({ chartOfAccountsId, amountCents });

describe("validateManualSplit", () => {
  it("accepts lines that sum exactly to the parent", () => {
    expect(validateManualSplit([line("a", -300000), line("b", -183355)], -483355)).toEqual({ ok: true });
  });

  it("rejects an off-by-one-cent total", () => {
    const result = validateManualSplit([line("a", -300000), line("b", -183354)], -483355);
    expect(result.ok).toBe(false);
  });

  it("rejects a single-line split", () => {
    expect(validateManualSplit([line("a", -483355)], -483355).ok).toBe(false);
  });

  it("rejects an empty split", () => {
    expect(validateManualSplit([], -483355).ok).toBe(false);
  });

  it("rejects a line whose sign opposes the parent", () => {
    expect(validateManualSplit([line("a", -600000), line("b", 116645)], -483355).ok).toBe(false);
  });

  it("rejects a zero-amount line", () => {
    expect(validateManualSplit([line("a", -483355), line("b", 0)], -483355).ok).toBe(false);
  });

  it("rejects a line with no GL account", () => {
    expect(validateManualSplit([line("", -300000), line("b", -183355)], -483355).ok).toBe(false);
  });

  it("rejects non-integer cents", () => {
    expect(validateManualSplit([line("a", -300000.5), line("b", -183354.5)], -483355).ok).toBe(false);
  });

  it("rejects splitting a zero-amount expense", () => {
    expect(validateManualSplit([line("a", 0), line("b", 0)], 0).ok).toBe(false);
  });

  it("accepts an inflow split (positive parent)", () => {
    expect(validateManualSplit([line("a", 1000), line("b", 500)], 1500)).toEqual({ ok: true });
  });
});

describe("splitRemainderCents", () => {
  it("reports what is left to allocate", () => {
    expect(splitRemainderCents([{ amountCents: -300000 }], -483355)).toBe(-183355);
  });

  it("reports zero when balanced", () => {
    expect(splitRemainderCents([{ amountCents: -300000 }, { amountCents: -183355 }], -483355)).toBe(0);
  });

  it("treats an empty set as fully unallocated", () => {
    expect(splitRemainderCents([], -483355)).toBe(-483355);
  });
});
