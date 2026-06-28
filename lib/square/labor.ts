import { squareGetAll, squareLocationId } from "./client";

interface SquareShift {
  id: string;
  team_member_id: string;
  location_id: string;
  start_at: string;
  end_at: string | null;
  status: "OPEN" | "CLOSED";
}

/**
 * Fetches all CLOSED shifts for the location within [startDate, endDate]
 * (inclusive, YYYY-MM-DD). Returns a map of team_member_id → total decimal hours.
 * Shifts without an end_at are skipped (still clocked in).
 */
export async function fetchShiftHours(
  startDate: string,
  endDate: string
): Promise<Map<string, number>> {
  const shifts = await squareGetAll<SquareShift>("/labor/shifts", "shifts", {
    location_id: squareLocationId(),
    start_at: `${startDate}T00:00:00Z`,
    end_at: `${endDate}T23:59:59Z`,
    status: "CLOSED",
  });

  const hoursMap = new Map<string, number>();
  for (const shift of shifts) {
    if (!shift.end_at) continue;
    const ms =
      new Date(shift.end_at).getTime() - new Date(shift.start_at).getTime();
    const hours = ms / (1000 * 60 * 60);
    hoursMap.set(
      shift.team_member_id,
      (hoursMap.get(shift.team_member_id) ?? 0) + hours
    );
  }
  return hoursMap;
}
