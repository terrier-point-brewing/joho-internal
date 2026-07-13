import { dayStartUtc, addDaysStr } from "@/lib/utils/datetime";

const MS_PER_DAY = 86_400_000;

/**
 * Whole calendar days actually covered by fetched net-sales for a set of
 * periods, as of `todayStr` (brewery-local). Each period that has started
 * contributes its span from `start` through `min(end, today)` INCLUSIVE — the
 * same window the net-sales fetch pulls (dayStart(start)…dayEnd(fetchEnd)).
 * Future periods (start after today) contribute nothing.
 *
 * This is the correct denominator for a $/day run rate whose numerator is the
 * summed net-sales of those periods. A week whose `end` is today is treated as
 * "complete" and contributes a full 7 days of revenue, so the elapsed-day count
 * must include today as well — otherwise the numerator spans more days than the
 * denominator, the daily rate is inflated, and the projection over-forecasts
 * (worst exactly on a week-ending day, where the mismatch is a full day).
 *
 * Day arithmetic goes through dayStartUtc so DST-length days round to whole
 * days, matching the period-span math used elsewhere in the achievement view.
 */
export function coveredSalesDays(
  periods: { start: string; end: string }[],
  todayStr: string,
  tz: string,
): number {
  let days = 0;
  for (const p of periods) {
    if (p.start > todayStr) continue; // not started yet
    const fetchEnd = p.end <= todayStr ? p.end : todayStr;
    const span = Math.round(
      (new Date(dayStartUtc(addDaysStr(fetchEnd, 1), tz)).getTime() -
        new Date(dayStartUtc(p.start, tz)).getTime()) /
        MS_PER_DAY,
    );
    days += span;
  }
  return days;
}
