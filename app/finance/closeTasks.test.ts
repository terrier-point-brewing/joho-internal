/**
 * The close page's steps, its summary line, the periods index and the Close
 * button all read these functions. They pin what was wrong before: a failing
 * recalculation was invisible until Close was pressed, the button stayed
 * enabled with duplicates outstanding, and a clean check was forgotten on
 * reload.
 */
import { describe, it, expect } from "vitest";
import {
  balancingDifferenceFor,
  closeBlockersFor,
  closeBlockersLeft,
  recalculationCheck,
  type CloseTasksResponse,
  type LastRecalculation,
} from "./closeTasks";

const run = (o: Partial<LastRecalculation> = {}): LastRecalculation => ({
  at: "2026-11-22T09:48:00Z",
  trigger: "schedule",
  errors: [],
  rawErrors: [],
  balancingDifferenceCents: null,
  ...o,
});

const period = (o: Partial<CloseTasksResponse> = {}): CloseTasksResponse => ({
  periodEnd: "2026-10-31",
  tasks: [],
  close: null,
  readyToClose: false,
  unreviewedDuplicates: 0,
  coverage: { configured: 39, withBalance: 26, missing: [], neverUsed: 13, balancingDifferenceCents: -949714 },
  recalculation: null,
  previousClose: null,
  dueDate: "2026-11-05",
  ...o,
});

describe("recalculationCheck", () => {
  it("is unknown, not clean, with nothing on record", () => {
    expect(recalculationCheck(null).state).toBe("unknown");
  });

  it("reports a failure", () => {
    const check = recalculationCheck(run({ errors: ["2410 Gift Card Liabilities could not be recalculated: a timeout."] }));
    expect(check.state).toBe("failing");
    expect(check.errors).toHaveLength(1);
  });

  it("reads a clean check run from the page as clean", () => {
    // The most recent run is all that is passed in, so a clean manual check is
    // what the page says, whatever last night's job found.
    expect(recalculationCheck(run({ trigger: "manual" }))).toMatchObject({ state: "clean", trigger: "manual" });
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
      "Step 3: the last recalculation failed. Press Check again.",
    ]);
  });

  it("blocks on duplicates alone", () => {
    // The button used to stay enabled here and refuse after the click.
    expect(closeBlockersLeft({ openTasks: 0, duplicates: 1, recalculation: "clean" })).toEqual([
      "Step 2: 1 possible duplicate to review.",
    ]);
  });
});

describe("closeBlockersFor", () => {
  it("has nothing to say about a closed month", () => {
    const closed = period({
      unreviewedDuplicates: 3,
      close: { periodEnd: "2026-10-31", closed: true, action: "closed", at: "2026-11-23T00:00:00Z", actorId: null, actorEmail: null, reason: null },
    });
    expect(closeBlockersFor(closed)).toEqual([]);
  });

  it("counts a failing recalculation, so the index and the page agree", () => {
    expect(closeBlockersFor(period({ recalculation: run({ errors: ["x"] }) }))).toHaveLength(1);
  });
});

describe("balancingDifferenceFor", () => {
  it("shows a closed month at what it was closed at", () => {
    const closed = period({
      recalculation: run({ balancingDifferenceCents: -1 }),
      close: { periodEnd: "2026-10-31", closed: true, action: "closed", at: "2026-11-23T00:00:00Z", actorId: null, actorEmail: null, reason: null },
    });
    expect(balancingDifferenceFor(closed)).toEqual({ cents: -949714, basis: "closed" });
  });

  it("prefers the latest recalculation on an open month", () => {
    // A check from the page is a dry run: it does not store its figure.
    expect(balancingDifferenceFor(period({ recalculation: run({ balancingDifferenceCents: -944908 }) }))).toEqual({
      cents: -944908,
      basis: "recalculated",
    });
  });

  it("falls back to the stored figure when the recalculation has none", () => {
    expect(balancingDifferenceFor(period({ recalculation: run() }))).toEqual({ cents: -949714, basis: "stored" });
  });
});
