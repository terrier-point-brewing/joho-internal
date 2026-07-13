import { describe, it, expect } from "vitest";
import { resolveDueDate, validateDueRule, readDueRule, type DueRule } from "./dueDate";

describe("resolveDueDate", () => {
  it("advances one month and picks the given day", () => {
    expect(resolveDueDate("2026-06-30", { monthOffset: 1, day: 20 })).toBe("2026-07-20");
  });

  it("advances one month and picks the last day", () => {
    expect(resolveDueDate("2026-06-30", { monthOffset: 1, day: "last" })).toBe("2026-07-31");
  });

  it("rolls the year over when the target month exceeds December", () => {
    expect(resolveDueDate("2026-12-31", { monthOffset: 1, day: 20 })).toBe("2027-01-20");
  });

  it("clamps the day to the target month's length (non-leap February)", () => {
    expect(resolveDueDate("2026-01-31", { monthOffset: 1, day: 31 })).toBe("2026-02-28");
  });

  it("clamps the day to the target month's length (leap February)", () => {
    expect(resolveDueDate("2028-01-31", { monthOffset: 1, day: 31 })).toBe("2028-02-29");
  });

  it("supports monthOffset 0 (same month)", () => {
    expect(resolveDueDate("2026-06-30", { monthOffset: 0, day: 15 })).toBe("2026-06-15");
  });
});

describe("validateDueRule", () => {
  it.each<unknown>([
    { monthOffset: 1.5, day: 20 },
    { monthOffset: -1, day: 20 },
    { monthOffset: 13, day: 20 },
    { monthOffset: 1, day: 0 },
    { monthOffset: 1, day: 32 },
    { monthOffset: 1, day: "lastly" },
    { day: 20 },
    null,
    "x",
  ])("rejects %j", (rule) => {
    expect(validateDueRule(rule)).not.toBeNull();
  });

  it.each<DueRule>([
    { monthOffset: 1, day: "last" },
    { monthOffset: 1, day: 1 },
    { monthOffset: 0, day: 31 },
  ])("accepts %j", (rule) => {
    expect(validateDueRule(rule)).toBeNull();
  });
});

describe("readDueRule", () => {
  it("returns null when config is undefined", () => {
    expect(readDueRule(undefined)).toBeNull();
  });

  it("returns null when config has no dueRule", () => {
    expect(readDueRule({})).toBeNull();
  });

  it("returns null when dueRule is present but invalid", () => {
    expect(readDueRule({ dueRule: {} })).toBeNull();
  });

  it("returns the DueRule when valid", () => {
    expect(readDueRule({ dueRule: { monthOffset: 1, day: 20 } })).toEqual({ monthOffset: 1, day: 20 });
  });
});
