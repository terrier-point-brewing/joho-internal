// Configurable filing due-date rule: advance a whole number of calendar
// months from a period's end date, then land on a given day-of-month (or the
// last day of that month). Pure, dependency-free, no I/O — same TZ-safety
// convention as lib/tax/period.ts (every Date built via Date.UTC(...) anchored
// at noon so a host timezone can never shift the intended calendar day).

export interface DueRule {
  monthOffset: number; // whole months to advance from periodEnd's month (0..12)
  day: number | "last"; // day-of-month to land on, clamped to the target month's length
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

/**
 * Due date for the period ending `periodEnd`. Advances `rule.monthOffset`
 * whole months from `periodEnd`'s calendar month (carrying the year), then
 * selects `rule.day` — clamped to the target month's length — or that
 * month's last calendar day when `rule.day === "last"`.
 */
export function resolveDueDate(periodEnd: string, rule: DueRule): string {
  const { y, m } = parseIsoParts(periodEnd);
  const totalMonths = (m - 1) + rule.monthOffset;
  const targetYear = y + Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  const lastDay = daysInMonth(targetYear, targetMonth);
  const day = rule.day === "last" ? lastDay : Math.min(rule.day, lastDay);
  return `${targetYear}-${pad2(targetMonth)}-${pad2(day)}`;
}

/**
 * Validates an unknown value as a `DueRule`. Returns `null` when valid, or a
 * human-readable error message describing the first problem found.
 */
export function validateDueRule(rule: unknown): string | null {
  if (typeof rule !== "object" || rule === null) {
    return "Due rule must be an object";
  }
  const { monthOffset, day } = rule as Record<string, unknown>;

  if (typeof monthOffset !== "number" || !Number.isInteger(monthOffset)) {
    return "monthOffset must be an integer";
  }
  if (monthOffset < 0 || monthOffset > 12) {
    return "monthOffset must be between 0 and 12";
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
