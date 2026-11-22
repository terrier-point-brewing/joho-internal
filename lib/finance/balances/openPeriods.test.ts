/** The pure rule is exercised in lib/alerts/sources/closeReadiness.test.ts, where it was written; this pins the re-export. */
import { describe, it, expect } from "vitest";
import { unclosedPeriodEnds } from "./openPeriods";
import { unclosedPeriodEnds as fromAlerts } from "@/lib/alerts/sources/closeReadiness";

describe("unclosedPeriodEnds", () => {
  it("is one definition, shared by the alert, the nightly job and the page", () => {
    expect(fromAlerts).toBe(unclosedPeriodEnds);
  });

  it("keeps an October nobody closed on the list in December", () => {
    const events = [{ period_end: "2026-09-30", action: "closed" as const, created_at: "2026-10-09T00:00:00Z" }];
    expect(unclosedPeriodEnds(events, "2026-12-03")).toEqual(["2026-10-31", "2026-11-30"]);
  });
});
