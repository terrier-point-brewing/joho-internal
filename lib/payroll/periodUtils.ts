export type PayPeriodFrequency = 'weekly' | 'biweekly';

/**
 * Computes start/end dates for the next pay period.
 * If no prior periods exist, uses firstPeriodStartDate as the start.
 * Otherwise, starts the day after lastEndDate.
 * Defaults to biweekly so existing callers without the frequency arg still work.
 */
export function computeNextPeriodDates(
  firstPeriodStartDate: string,
  lastEndDate: string | null,
  frequency: PayPeriodFrequency = 'biweekly'
): { start_date: string; end_date: string } {
  const span = frequency === 'weekly' ? 6 : 13;
  let start: Date;
  if (!lastEndDate) {
    start = new Date(firstPeriodStartDate);
  } else {
    start = new Date(lastEndDate);
    start.setUTCDate(start.getUTCDate() + 1);
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + span);
  return {
    start_date: start.toISOString().slice(0, 10),
    end_date:   end.toISOString().slice(0, 10),
  };
}

/**
 * Returns every consecutive period from firstPeriodStartDate up to and
 * including the period whose start_date <= throughDate.
 * Used to seed all missing periods when payroll config is saved.
 */
export function seedPeriodDates(
  firstPeriodStartDate: string,
  frequency: PayPeriodFrequency,
  throughDate: string
): Array<{ start_date: string; end_date: string }> {
  const span = frequency === 'weekly' ? 6 : 13;
  const periods: Array<{ start_date: string; end_date: string }> = [];
  const through = new Date(throughDate);
  let start = new Date(firstPeriodStartDate);

  while (start <= through) {
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + span);
    periods.push({
      start_date: start.toISOString().slice(0, 10),
      end_date:   end.toISOString().slice(0, 10),
    });
    start = new Date(end);
    start.setUTCDate(start.getUTCDate() + 1);
  }

  return periods;
}
