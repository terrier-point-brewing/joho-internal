/**
 * Pins the one claim the whole capture schedule rests on.
 *
 * The route records `todayLocalDate()` — the calendar date at the brewery at
 * the instant of the run — and is scheduled at 02:00 UTC precisely so that
 * instant falls late on the PREVIOUS day locally. If that ever stops being
 * true, every capture silently files itself a day late: 31 August's balance
 * would be stored as 1 September's, the month-end lookup would miss, and the
 * bank row would read as unsourced with nothing to explain why.
 *
 * Asserted on both sides of daylight saving, which is the reason the schedule
 * is 02:00 rather than an hour closer to midnight.
 */
import { describe, it, expect } from "vitest";
import { todayLocalDate } from "@/lib/utils/datetime";
import { CRON_JOBS } from "@/lib/cron/registry";
import vercel from "@/vercel.json";

const SCHEDULE = "0 2 * * *";

describe("balance-capture schedule", () => {
  it("is registered in both the cron monitor and vercel.json, with the same expression", () => {
    // The monitor lists jobs that have never run; vercel.json is what actually
    // fires them. A job in one and not the other is invisible or dead.
    const meta = CRON_JOBS.find((j) => j.job === "balance-capture");
    expect(meta, "balance-capture is missing from the cron monitor registry").toBeDefined();
    expect(meta!.schedule).toBe(SCHEDULE);

    const scheduled = (vercel as { crons: { path: string; schedule: string }[] }).crons.find(
      (c) => c.path === "/api/cron/balance-capture",
    );
    expect(scheduled, "balance-capture is missing from vercel.json").toBeDefined();
    expect(scheduled!.schedule).toBe(meta!.schedule);
    expect(meta!.path).toBe(scheduled!.path);
  });

  it("records the previous local day when it fires in summer (EDT, UTC-4)", () => {
    // 02:00 UTC on 1 September is 22:00 on 31 August at the brewery.
    expect(todayLocalDate(undefined, new Date("2026-09-01T02:00:00Z"))).toBe("2026-08-31");
  });

  it("records the previous local day when it fires in winter (EST, UTC-5)", () => {
    expect(todayLocalDate(undefined, new Date("2027-01-01T02:00:00Z"))).toBe("2026-12-31");
  });

  it("still lands on the previous day on each daylight-saving changeover", () => {
    // Spring forward 2026-03-08, fall back 2026-11-01. An hour nearer midnight
    // would cross the date line on one side of these and not the other.
    expect(todayLocalDate(undefined, new Date("2026-03-08T02:00:00Z"))).toBe("2026-03-07");
    expect(todayLocalDate(undefined, new Date("2026-11-01T02:00:00Z"))).toBe("2026-10-31");
  });

  it("writes the month-end capture before the close job that reads it", () => {
    // balance-close runs at 09:00 UTC and snapshots the most recently ended
    // month, so on 1 September it looks up 31 August -- captured seven hours
    // earlier the same UTC day. Neither job knows about the other; the
    // ordering has to come from the schedules.
    const close = CRON_JOBS.find((j) => j.job === "balance-close")!;
    const captureHour = Number(SCHEDULE.split(" ")[1]);
    const closeHour = Number(close.schedule.split(" ")[1]);
    expect(captureHour).toBeLessThan(closeHour);
  });
});
