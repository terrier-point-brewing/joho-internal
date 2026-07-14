import { squarePostAll, squareLocationId } from "./client";

interface SquareShift {
  id: string;
  employee_id: string;
  location_id: string;
  start_at: string;
  end_at: string | null;
  status: "OPEN" | "CLOSED";
  declared_cash_tip_money?: { amount: number; currency: string };
}

/**
 * Fetches all CLOSED shifts for the location within [startDate, endDate]
 * (inclusive, YYYY-MM-DD) via POST /v2/labor/shifts/search.
 * Returns a map of team_member_id → total decimal hours.
 * Shifts without an end_at are skipped (still clocked in).
 *
 * Note: Square's shift object uses `employee_id` which is the team member ID —
 * matches square_team_member_id in the employees table.
 */
export async function fetchShiftHours(
  startDate: string,
  endDate: string
): Promise<Map<string, number>> {
  const shifts = await squarePostAll<SquareShift>(
    "/labor/shifts/search",
    "shifts",
    {
      query: {
        filter: {
          location_ids: [squareLocationId()],
          status: "CLOSED",
          start: {
            start_at: `${startDate}T00:00:00Z`,
            end_at:   `${endDate}T23:59:59Z`,
          },
        },
      },
    }
  );

  const hoursMap = new Map<string, number>();
  for (const shift of shifts) {
    if (!shift.end_at) continue;
    const ms = new Date(shift.end_at).getTime() - new Date(shift.start_at).getTime();
    const hours = ms / (1000 * 60 * 60);
    hoursMap.set(
      shift.employee_id,
      (hoursMap.get(shift.employee_id) ?? 0) + hours
    );
  }
  return hoursMap;
}

export interface DailyShift {
  team_member_id: string;
  date: string; // YYYY-MM-DD local date
  hours: number;
  cash_tips_cents: number; // sum of declared_cash_tip_money for this member on this day
}

/**
 * Pure aggregation of raw shifts into per-member-per-day hours + declared cash tips.
 * Open shifts (no end_at) are skipped. Date is the local portion of start_at.
 * Extracted for unit testing; fetchShiftsByDay wraps the Square call around it.
 */
export function aggregateDailyShifts(
  shifts: Array<{
    employee_id: string;
    start_at: string;
    end_at: string | null;
    declared_cash_tip_money?: { amount: number };
  }>
): DailyShift[] {
  const acc = new Map<string, Map<string, { hours: number; cash: number }>>();
  for (const shift of shifts) {
    if (!shift.end_at) continue;
    const date = shift.start_at.split("T")[0];
    const ms = new Date(shift.end_at).getTime() - new Date(shift.start_at).getTime();
    const hours = ms / (1000 * 60 * 60);
    const cash = shift.declared_cash_tip_money?.amount ?? 0;
    if (!acc.has(shift.employee_id)) acc.set(shift.employee_id, new Map());
    const dayMap = acc.get(shift.employee_id)!;
    const cur = dayMap.get(date) ?? { hours: 0, cash: 0 };
    cur.hours += hours;
    cur.cash += cash;
    dayMap.set(date, cur);
  }
  const result: DailyShift[] = [];
  for (const [tid, dayMap] of acc)
    for (const [date, { hours, cash }] of dayMap)
      result.push({ team_member_id: tid, date, hours, cash_tips_cents: cash });
  return result;
}

/**
 * Same shift search as fetchShiftHours, but returns per-day granularity.
 * Date is taken from the local portion of the ISO start_at timestamp.
 */
export async function fetchShiftsByDay(
  startDate: string,
  endDate: string
): Promise<DailyShift[]> {
  const shifts = await squarePostAll<SquareShift>(
    "/labor/shifts/search",
    "shifts",
    {
      query: {
        filter: {
          location_ids: [squareLocationId()],
          status: "CLOSED",
          start: {
            start_at: `${startDate}T00:00:00Z`,
            end_at:   `${endDate}T23:59:59Z`,
          },
        },
      },
    }
  );

  return aggregateDailyShifts(shifts);
}
