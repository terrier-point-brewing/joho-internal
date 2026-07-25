import { describe, it, expect } from "vitest";
import { validateManualSplit, splitRemainderCents, centsFromRaw, rawFromCents } from "./expenseSplits";

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

describe("centsFromRaw", () => {
  it("parses a plain amount", () => {
    expect(centsFromRaw("123.45")).toBe(12345);
  });

  it("parses a negative amount (outflow)", () => {
    expect(centsFromRaw("-4833.55")).toBe(-483355);
  });

  it("parses each prefix of a value typed left-to-right, so no keystroke is swallowed", () => {
    // Regression: binding the field to a re-formatted number meant typing "1"
    // into "0.00" produced "0.001" -> 0 cents -> re-render as "0.00".
    expect(["1", "12", "12.", "12.3", "12.34"].map(centsFromRaw)).toEqual([100, 1200, 1200, 1230, 1234]);
  });

  it("treats an empty or partial field as zero rather than NaN", () => {
    expect(centsFromRaw("")).toBe(0);
    expect(centsFromRaw("-")).toBe(0);
    expect(centsFromRaw(".")).toBe(0);
  });

  it("treats junk as zero rather than letting NaN reach validation", () => {
    expect(centsFromRaw("1.2.3")).toBe(0);
    expect(centsFromRaw("abc")).toBe(0);
  });

  it("tolerates surrounding whitespace", () => {
    expect(centsFromRaw("  12.34  ")).toBe(1234);
  });

  it("rounds sub-cent input to the nearest cent", () => {
    expect(centsFromRaw("0.005")).toBe(1);
    expect(centsFromRaw("0.004")).toBe(0);
  });
});

describe("rawFromCents", () => {
  it("renders two decimals", () => {
    expect(rawFromCents(12345)).toBe("123.45");
    expect(rawFromCents(0)).toBe("0.00");
    expect(rawFromCents(-483355)).toBe("-4833.55");
  });

  it("round-trips through centsFromRaw", () => {
    for (const cents of [0, 1, -1, 1234, -483355]) {
      expect(centsFromRaw(rawFromCents(cents))).toBe(cents);
    }
  });
});
