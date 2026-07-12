import { describe, it, expect } from "vitest";
import { taskDueStatus } from "./taskDueStatus";
import type { TaxSchedule, TaxTask } from "./types";

const TODAY = "2026-07-12";

function task(overrides: Partial<TaxTask> = {}): Pick<TaxTask, "due_date" | "status"> {
  return { due_date: "2026-07-20", status: "open", ...overrides };
}

function schedule(leadDays: number): Pick<TaxSchedule, "lead_days"> {
  return { lead_days: leadDays };
}

describe("taskDueStatus", () => {
  it("returns 'overdue' when due_date is before today and the task is open", () => {
    expect(taskDueStatus(task({ due_date: "2026-07-11" }), schedule(5), TODAY)).toBe("overdue");
  });

  it("returns 'due-soon' when due_date falls within the schedule's lead_days", () => {
    expect(taskDueStatus(task({ due_date: "2026-07-15" }), schedule(5), TODAY)).toBe("due-soon");
  });

  it("treats due_date exactly on the lead_days boundary as 'due-soon'", () => {
    expect(taskDueStatus(task({ due_date: "2026-07-17" }), schedule(5), TODAY)).toBe("due-soon");
  });

  it("treats due_date == today as 'due-soon' regardless of lead_days", () => {
    expect(taskDueStatus(task({ due_date: TODAY }), schedule(0), TODAY)).toBe("due-soon");
  });

  it("returns 'open' when due_date is beyond the lead_days window", () => {
    expect(taskDueStatus(task({ due_date: "2026-07-18" }), schedule(5), TODAY)).toBe("open");
  });

  it("falls back to a 0-day lead window when no schedule is provided", () => {
    expect(taskDueStatus(task({ due_date: "2026-07-13" }), null, TODAY)).toBe("open");
  });

  it("never flags a non-open task as overdue or due-soon", () => {
    expect(taskDueStatus(task({ due_date: "2020-01-01", status: "completed" }), schedule(30), TODAY)).toBe("open");
    expect(taskDueStatus(task({ due_date: "2020-01-01", status: "skipped" }), schedule(30), TODAY)).toBe("open");
  });

  it("accepts a Date instance for `today` in addition to an ISO string", () => {
    expect(taskDueStatus(task({ due_date: "2026-07-11" }), schedule(5), new Date(`${TODAY}T00:00:00Z`))).toBe("overdue");
  });
});
