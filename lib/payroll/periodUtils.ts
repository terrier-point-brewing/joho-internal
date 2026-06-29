export type PayPeriodFrequency = 'weekly' | 'biweekly';

/**
 * Computes start/end dates for the next pay period.
 * - If lastEndDate is provided: start = lastEndDate + 1 day.
 * - If lastEndDate is null: start = fallbackStart (defaults to today).
 */
export function computeNextPeriodDates(
  lastEndDate: string | null,
  frequency: PayPeriodFrequency,
  fallbackStart?: string
): { start_date: string; end_date: string } {
  const span = frequency === 'weekly' ? 6 : 13;
  let start: Date;
  if (lastEndDate) {
    start = new Date(lastEndDate);
    start.setUTCDate(start.getUTCDate() + 1);
  } else {
    start = new Date(fallbackStart ?? new Date().toISOString().slice(0, 10));
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + span);
  return {
    start_date: start.toISOString().slice(0, 10),
    end_date:   end.toISOString().slice(0, 10),
  };
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
