/**
 * Computes start/end dates for the next biweekly pay period.
 * If no prior periods exist, uses firstPeriodStartDate as the start.
 * Otherwise, starts the day after lastEndDate.
 */
export function computeNextPeriodDates(
  firstPeriodStartDate: string,
  lastEndDate: string | null
): { start_date: string; end_date: string } {
  let start: Date;
  if (!lastEndDate) {
    start = new Date(firstPeriodStartDate);
  } else {
    start = new Date(lastEndDate);
    start.setUTCDate(start.getUTCDate() + 1);
  }

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 13); // 14-day period inclusive

  return {
    start_date: start.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10),
  };
}
