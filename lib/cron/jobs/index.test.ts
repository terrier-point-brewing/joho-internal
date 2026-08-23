/**
 * The registry and the work behind it have to agree.
 *
 * A job listed in one and missing from the other is a "Run now" button that
 * answers "there is no job by that name", or a job that runs on a schedule and
 * never appears in the monitor. Both are only findable in production without
 * this file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CRON_JOBS } from "@/lib/cron/registry";
import { CRON_JOB_DEFINITIONS, getCronJob, jobsWithoutWork } from "./index";

describe("every scheduled job can be run", () => {
  it("has work attached to every entry in the registry", () => {
    expect(jobsWithoutWork()).toEqual([]);
  });

  it("offers exactly the jobs the registry lists, and no others", () => {
    expect(CRON_JOB_DEFINITIONS.map((d) => d.job).sort()).toEqual(CRON_JOBS.map((j) => j.job).sort());
  });

  it("finds a job by the same name the run history uses", () => {
    for (const meta of CRON_JOBS) {
      expect(getCronJob(meta.job)?.job).toBe(meta.job);
    }
  });

  it("answers with nothing for a name it does not know", () => {
    // The name arrives off a request, so an unknown one is a 404 rather than a
    // crash.
    expect(getCronJob("not-a-job")).toBeUndefined();
    expect(getCronJob("")).toBeUndefined();
  });
});

describe("what a manual run promises", () => {
  it("says for every job whether the request waits or reports that it started", () => {
    for (const meta of CRON_JOBS) {
      expect(["wait", "start"]).toContain(meta.manualRun);
    }
  });

  it("makes the slow jobs report that they started rather than holding a browser open", () => {
    // Each of these pages against a bank or against Square and can run for
    // minutes; its own route already asks for the longest time limit available.
    for (const job of ["balance-capture", "bank-transactions-sync", "finance-sync", "finance-gap-scan"]) {
      expect(getCronJob(job)?.manualRun).toBe("start");
    }
  });

  it("warns before running anything that emails, freezes a month, or rebuilds hand-coded lines", () => {
    for (const job of ["balance-close", "tax-tasks", "finance-sync", "finance-gap-scan", "ramp-expenses-sync"]) {
      expect(getCronJob(job)?.manualNote ?? "").not.toBe("");
    }
  });

  it("writes those warnings for an operator, not for a developer", () => {
    // Full sentences, no table or column names — this is read by whoever is
    // deciding whether to press the button.
    for (const meta of CRON_JOBS) {
      if (!meta.manualNote) continue;
      expect(meta.manualNote).toMatch(/\.$/);
      expect(meta.manualNote).not.toMatch(/_|\(\)/);
    }
  });
});

describe("the registry still matches the schedule", () => {
  it("gives every job a path under the cron routes", () => {
    for (const meta of CRON_JOBS) {
      expect(meta.path).toBe(`/api/cron/${meta.job}`);
    }
  });

  // The registry's own header says to keep these in sync with vercel.json by
  // hand. Vercel reads vercel.json and nothing else, so a job added to only one
  // of the two either never fires or fires while the monitor denies it exists —
  // and both look fine until someone goes looking.
  it("lists exactly the jobs vercel.json schedules, at the same times", () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
      crons: { path: string; schedule: string }[];
    };
    const scheduled = new Map(vercel.crons.map((c) => [c.path, c.schedule]));
    const registered = new Map(CRON_JOBS.map((j) => [j.path, j.schedule]));

    expect([...scheduled.keys()].sort()).toEqual([...registered.keys()].sort());
    for (const [path, schedule] of registered) {
      expect(scheduled.get(path)).toBe(schedule);
    }
  });

  // Two shapes of schedule now exist, and each gets the assertion it can
  // actually satisfy. Until the publishing worker landed, every job here fired
  // at a fixed hour, so "the label contains HH:MM" was the whole rule. An
  // interval schedule names no hour at all — `*/5 * * * *` would produce the
  // nonsense "0*:*/5" — so it is checked against the interval it does name.
  // Neither branch is a relaxation: a schedule that matches neither shape is a
  // failure, so a new expression cannot slip through unlabelled.
  it("labels each schedule with the hour or the interval its cron expression actually names", () => {
    for (const meta of CRON_JOBS) {
      const [minute, hour] = meta.schedule.split(" ");
      const everyNMinutes = /^\*\/(\d+)$/.exec(minute);

      if (everyNMinutes && hour === "*") {
        expect(meta.scheduleLabel).toContain(`Every ${everyNMinutes[1]} minutes`);
        continue;
      }

      expect(minute, `${meta.job}: unrecognised schedule shape "${meta.schedule}"`).toMatch(/^\d+$/);
      expect(hour, `${meta.job}: unrecognised schedule shape "${meta.schedule}"`).toMatch(/^\d+$/);
      const hh = String(hour).padStart(2, "0");
      const mm = String(minute).padStart(2, "0");
      expect(meta.scheduleLabel).toContain(`${hh}:${mm}`);
    }
  });
});
