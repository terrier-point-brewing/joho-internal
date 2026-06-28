import { describe, it, expect } from "vitest";
import { computeNextPeriodDates } from "../periodUtils";

describe("computeNextPeriodDates", () => {
  it("uses anchor date when no prior periods", () => {
    const result = computeNextPeriodDates("2026-01-05", null);
    expect(result.start_date).toBe("2026-01-05");
    expect(result.end_date).toBe("2026-01-18");
  });

  it("starts the day after the last period's end", () => {
    const result = computeNextPeriodDates("2026-01-05", "2026-01-18");
    expect(result.start_date).toBe("2026-01-19");
    expect(result.end_date).toBe("2026-02-01");
  });
});
