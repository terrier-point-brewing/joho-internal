import { describe, it, expect } from "vitest";
import { conversionTargetStatus, isForward } from "./conversionFinalizer";

describe("conversionTargetStatus", () => {
  it("maps brite → conditioning and fermenter → fermenting", () => {
    expect(conversionTargetStatus("brite")).toBe("conditioning");
    expect(conversionTargetStatus("fermenter")).toBe("fermenting");
  });
  it("returns null for unconstrained / unknown dest types", () => {
    expect(conversionTargetStatus("kegging")).toBeNull();
    expect(conversionTargetStatus(null)).toBeNull();
    expect(conversionTargetStatus(undefined)).toBeNull();
  });
});

describe("isForward", () => {
  it("advances planning → conditioning", () => {
    expect(isForward("planning", "conditioning")).toBe(true);
  });
  it("does not regress conditioning → fermenting", () => {
    expect(isForward("conditioning", "fermenting")).toBe(false);
  });
  it("treats null/unknown current status as earliest, and never advances past complete", () => {
    expect(isForward(null, "fermenting")).toBe(true);
    expect(isForward("complete", "conditioning")).toBe(false);
  });
});
