/**
 * Payroll pay-period month proration.
 *
 * A matched expense's GL split-line amounts are attributed to the calendar
 * month(s) its pay period actually covers -- not the month the Gusto
 * withdrawal happened to post in. Pure day-count proration with
 * largest-remainder rounding (same technique as computeProportionalSplits
 * in ./payrollMatching.ts), so the parts always sum exactly to the input.
 * No DB/React imports -- shared by aggregateRows.ts (server) and
 * PayrollSplitCell.tsx (client).
 *
 * See docs/superpowers/specs/2026-07-17-payroll-gl-split-month-proration-design.md.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDateUTC(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function monthKeyOfUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface MonthAllocation {
  monthKey: string; // "YYYY-MM"
  amountCents: number;
}

/**
 * Splits amountCents across every calendar month the inclusive
 * [periodStart, periodEnd] range touches, proportional to each month's day
 * count within the range. amountCents may be negative (outflow, the usual
 * case for expenses) or positive; the sign is preserved and parts always
 * sum exactly to amountCents via largest-remainder rounding. A single-month
 * period returns a one-element array.
 */
export function prorateAcrossMonths(amountCents: number, periodStart: string, periodEnd: string): MonthAllocation[] {
  const start = parseDateUTC(periodStart);
  const end = parseDateUTC(periodEnd);

  const dayCountByMonth = new Map<string, number>();
  let totalDays = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += MS_PER_DAY) {
    const key = monthKeyOfUTC(new Date(t));
    dayCountByMonth.set(key, (dayCountByMonth.get(key) ?? 0) + 1);
    totalDays += 1;
  }

  const months = [...dayCountByMonth.keys()];
  const lines = months.map((monthKey) => {
    const days = dayCountByMonth.get(monthKey)!;
    const raw = (amountCents * days) / totalDays;
    const truncated = Math.trunc(raw); // amountCents is often negative; truncate toward zero, not floor toward -Infinity
    return { monthKey, amountCents: truncated, remainder: Math.abs(raw - truncated) };
  });

  const truncatedSum = lines.reduce((s, l) => s + l.amountCents, 0);
  const toDistributeTotal = amountCents - truncatedSum;
  const direction = toDistributeTotal > 0 ? 1 : toDistributeTotal < 0 ? -1 : 0;

  // Largest remainder first; ties keep the original (chronological) order (stable sort).
  const order = [...lines.keys()].sort((a, b) => lines[b].remainder - lines[a].remainder);
  let remaining = Math.abs(toDistributeTotal);
  for (const idx of order) {
    if (remaining === 0) break;
    lines[idx].amountCents += direction;
    remaining -= 1;
  }

  return lines.map((l) => ({ monthKey: l.monthKey, amountCents: l.amountCents }));
}
