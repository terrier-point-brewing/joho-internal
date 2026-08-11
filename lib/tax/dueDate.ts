// Configurable filing due-date rule. Two shapes, because filings come in two
// shapes:
//
//   RELATIVE  { monthOffset, day } — advance a whole number of calendar months
//             from a period's end date, then land on a given day-of-month (or
//             the last day of that month). "Due the 20th of the following
//             month" is the archetype.
//   FIXED     { fixedMonth, day }  — a calendar deadline that does not move
//             with the period: the FIRST fixedMonth/day strictly after the
//             period ends. Wake County's beer & wine renewal is due April 30
//             every year, full stop; expressing that as "12 months after the
//             period end" happens to compute the same date but hides what the
//             rule actually is, and silently breaks if the period definition
//             is ever adjusted.
//
// Pure, dependency-free, no I/O — same TZ-safety convention as
// lib/tax/period.ts (every Date built via Date.UTC(...) anchored at noon so a
// host timezone can never shift the intended calendar day).

export interface RelativeDueRule {
  monthOffset: number; // whole months to advance from periodEnd's month (0..12)
  day: number | "last"; // day-of-month to land on, clamped to the target month's length
}

export interface FixedDueRule {
  fixedMonth: number; // 1..12, the calendar month the filing is always due in
  day: number | "last"; // day-of-month within it, clamped to that month's length
}

export type DueRule = RelativeDueRule | FixedDueRule;

export function isFixedDueRule(rule: DueRule): rule is FixedDueRule {
  return typeof (rule as FixedDueRule).fixedMonth === "number";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parseIsoParts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

// Number of days in month `m` (1-indexed) of year `y`, computed via the same
// UTC-noon "day 0 of next month" technique lib/tax/period.ts uses internally.
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0, 12)).getUTCDate();
}

function dayIn(y: number, m: number, day: number | "last"): number {
  const lastDay = daysInMonth(y, m);
  return day === "last" ? lastDay : Math.min(day, lastDay);
}

/**
 * Due date for the period ending `periodEnd`.
 *
 * Relative rule: advances `monthOffset` whole months from `periodEnd`'s
 * calendar month (carrying the year), then selects `day` — clamped to the
 * target month's length — or that month's last calendar day for `"last"`.
 *
 * Fixed rule: the first `fixedMonth`/`day` STRICTLY after `periodEnd`. A
 * period ending on the deadline itself therefore rolls to the next year, which
 * is what makes it usable for a renewal (the task opens when the period closes
 * and carries the next deadline, never one already past).
 */
export function resolveDueDate(periodEnd: string, rule: DueRule): string {
  const { y, m } = parseIsoParts(periodEnd);

  if (isFixedDueRule(rule)) {
    let targetYear = y;
    let candidate = `${targetYear}-${pad2(rule.fixedMonth)}-${pad2(dayIn(targetYear, rule.fixedMonth, rule.day))}`;
    if (candidate <= periodEnd) {
      targetYear += 1;
      candidate = `${targetYear}-${pad2(rule.fixedMonth)}-${pad2(dayIn(targetYear, rule.fixedMonth, rule.day))}`;
    }
    return candidate;
  }

  const totalMonths = (m - 1) + rule.monthOffset;
  const targetYear = y + Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  return `${targetYear}-${pad2(targetMonth)}-${pad2(dayIn(targetYear, targetMonth, rule.day))}`;
}

/**
 * Validates an unknown value as a `DueRule`. Returns `null` when valid, or a
 * human-readable error message describing the first problem found.
 */
export function validateDueRule(rule: unknown): string | null {
  if (typeof rule !== "object" || rule === null) {
    return "Due rule must be an object";
  }
  const { monthOffset, fixedMonth, day } = rule as Record<string, unknown>;

  if (fixedMonth !== undefined) {
    if (monthOffset !== undefined) {
      return "Due rule must set either monthOffset or fixedMonth, not both";
    }
    if (typeof fixedMonth !== "number" || !Number.isInteger(fixedMonth)) {
      return "fixedMonth must be an integer";
    }
    if (fixedMonth < 1 || fixedMonth > 12) {
      return "fixedMonth must be between 1 and 12";
    }
  } else {
    if (typeof monthOffset !== "number" || !Number.isInteger(monthOffset)) {
      return "monthOffset must be an integer";
    }
    if (monthOffset < 0 || monthOffset > 12) {
      return "monthOffset must be between 0 and 12";
    }
  }

  if (day === "last") {
    return null;
  }
  if (typeof day !== "number" || !Number.isInteger(day)) {
    return "day must be an integer or \"last\"";
  }
  if (day < 1 || day > 31) {
    return "day must be between 1 and 31";
  }

  return null;
}

/**
 * Safely reads a `DueRule` out of a `tax_schedules.config` blob. Returns
 * `null` (never throws) when `config` is absent or `config.dueRule` is
 * missing/invalid, so callers can fall back to the party's default rule.
 */
export function readDueRule(config: Record<string, unknown> | undefined): DueRule | null {
  const candidate = config?.dueRule;
  if (validateDueRule(candidate) !== null) return null;
  return candidate as DueRule;
}
