import { describe, it, expect } from "vitest";
import { coveredSalesDays } from "./achievementPace";

const TZ = "America/New_York";

// Q3 2026 weekly periods as built by AchievementTab (weeks snap to Monday and
// clip to the quarter). Q3 starts Wed Jul 1; today is Sun Jul 12.
const Q3_WEEKS = [
  { start: "2026-07-01", end: "2026-07-05" }, // 5-day leading stub (Wed–Sun)
  { start: "2026-07-06", end: "2026-07-12" }, // full week, ends today
  { start: "2026-07-13", end: "2026-07-19" }, // future
  { start: "2026-07-20", end: "2026-07-26" }, // future
];

describe("coveredSalesDays", () => {
  it("counts today when a completed week ends today (the over-forecast bug)", () => {
    // Jul 1–5 (5) + Jul 6–12 (7) = 12; NOT 11 (start-of-day-to-start-of-day).
    expect(coveredSalesDays(Q3_WEEKS, "2026-07-12", TZ)).toBe(12);
  });

  it("counts an in-progress period through today inclusive", () => {
    // Thu Jul 9: week 1 complete (5) + week 2 in progress Jul 6–9 (4) = 9.
    expect(coveredSalesDays(Q3_WEEKS, "2026-07-09", TZ)).toBe(9);
  });

  it("ignores periods that have not started", () => {
    // Jul 12: only weeks 1 and 2 have started.
    const withFuture = coveredSalesDays(Q3_WEEKS, "2026-07-12", TZ);
    const withoutFuture = coveredSalesDays(Q3_WEEKS.slice(0, 2), "2026-07-12", TZ);
    expect(withFuture).toBe(withoutFuture);
  });

  it("counts only the first day on the quarter's opening day", () => {
    expect(coveredSalesDays(Q3_WEEKS, "2026-07-01", TZ)).toBe(1);
  });

  it("returns 0 before any period has started", () => {
    expect(coveredSalesDays(Q3_WEEKS, "2026-06-30", TZ)).toBe(0);
  });

  it("sums full spans once every period is complete", () => {
    // 5 + 7 + 7 + 7 = 26 days of the quarter covered so far.
    expect(coveredSalesDays(Q3_WEEKS, "2026-07-26", TZ)).toBe(26);
  });

  it("handles a spring-forward DST week as whole days", () => {
    // DST begins Sun Mar 8 2026; the week spanning it is still 7 whole days.
    const marWeek = [{ start: "2026-03-02", end: "2026-03-08" }];
    expect(coveredSalesDays(marWeek, "2026-03-08", TZ)).toBe(7);
  });
});
