/**
 * The registry and the work behind it have to agree.
 *
 * A job listed in one and missing from the other is a "Run now" button that
 * answers "there is no job by that name", or a job that runs on a schedule and
 * never appears in the monitor. Both are only findable in production without
 * this file.
 */
import { describe, it, expect } from "vitest";
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
});
