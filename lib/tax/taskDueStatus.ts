/**
 * Client-side urgency classification for an open tax task, used by the
 * Finance → Tax task list to pick a badge tone. Not persisted — `open`,
 * `completed`, `skipped` remain the only DB-backed statuses (see
 * `TaxTaskStatus` in `lib/tax/types.ts`); this derives a finer-grained view
 * for `status === "open"` rows only.
 */
import { addDaysIso } from "./period";
import type { TaxSchedule, TaxTask } from "./types";

export type TaskUrgency = "overdue" | "due-soon" | "open";

/** `today` accepts a Date or an already-formatted YYYY-MM-DD string (tests pass strings). */
function toISODate(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString().slice(0, 10);
}

/**
 * Non-open tasks (completed/skipped) always classify as "open" here — callers
 * are expected to only invoke this for the open-tasks section of the list and
 * branch on `task.status` separately for the completed section.
 */
export function taskDueStatus(
  task: Pick<TaxTask, "due_date" | "status">,
  schedule: Pick<TaxSchedule, "lead_days"> | null | undefined,
  today: Date | string,
): TaskUrgency {
  if (task.status !== "open") return "open";

  const todayISO = toISODate(today);
  if (task.due_date < todayISO) return "overdue";

  const leadDays = schedule?.lead_days ?? 0;
  const dueSoonThreshold = addDaysIso(todayISO, leadDays);
  if (task.due_date <= dueSoonThreshold) return "due-soon";

  return "open";
}
