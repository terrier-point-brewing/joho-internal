/**
 * The close page's steps, summary line and Close button all read these two
 * functions. They pin the two things that were wrong before: a failing
 * recalculation was invisible until Close was pressed, and the button stayed
 * enabled with duplicates outstanding.
 */
import { describe, it, expect } from "vitest";
import { closeBlockersLeft, recalculationCheck } from "./closeTasks";

describe("recalculationCheck", () => {
  it("is unknown, not clean, with nothing on record", () => {
    expect(recalculationCheck(null, null).state).toBe("unknown");
  });

  it("reports last night's failure", () => {
    const check = recalculationCheck({ at: "2026-11-22T09:48:00Z", errors: ["gift cards timed out"] }, null);
    expect(check).toEqual({ state: "failing", errors: ["gift cards timed out"], at: "2026-11-22T09:48:00Z", source: "nightly" });
  });

  it("reports a clean night", () => {
    expect(recalculationCheck({ at: "2026-11-21T09:48:00Z", errors: [] }, null).state).toBe("clean");
  });

  it("lets a clean preview clear last night's failure", () => {
    // The fix landed today; nobody should have to wait a night to close.
    const check = recalculationCheck({ at: "2026-11-22T09:48:00Z", errors: ["timeout"] }, { errors: [] });
    expect(check.state).toBe("clean");
    expect(check.source).toBe("preview");
  });

  it("lets a failing preview override a clean night", () => {
    expect(recalculationCheck({ at: "2026-11-21T09:48:00Z", errors: [] }, { errors: ["timeout"] }).state).toBe("failing");
  });
});

describe("closeBlockersLeft", () => {
  it("is empty when nothing is left", () => {
    expect(closeBlockersLeft({ openTasks: 0, duplicates: 0, recalculation: "clean" })).toEqual([]);
  });

  it("does not block on an unknown recalculation", () => {
    expect(closeBlockersLeft({ openTasks: 0, duplicates: 0, recalculation: "unknown" })).toEqual([]);
  });

  it("names each step that is left", () => {
    expect(closeBlockersLeft({ openTasks: 1, duplicates: 2, recalculation: "failing" })).toEqual([
      "Step 1: 1 account still needs a balance.",
      "Step 2: 2 possible duplicates to review.",
      "Step 3: the recalculation is failing.",
    ]);
  });

  it("blocks on duplicates alone", () => {
    // The button used to stay enabled here and refuse after the click.
    expect(closeBlockersLeft({ openTasks: 0, duplicates: 1, recalculation: "clean" })).toEqual([
      "Step 2: 1 possible duplicate to review.",
    ]);
  });
});
