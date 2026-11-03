/**
 * Event tips that reach a paycheck.
 *
 * An event's card tips are carved out of the taproom pool at source
 * (lib/square/payroll.ts). When an EMPLOYEE worked the event, the manager
 * records their share on the Events tab with method 'payroll'; this loader
 * turns those rows into the per-day cents the payroll grid lands on top of
 * the employee's pool share. The row is keyed to the event's brewery-local
 * day, so it falls in the pay period that contains the event, not the one
 * in which it was typed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { localDateString, addDaysStr } from "@/lib/utils/datetime";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";
import type { EventTipPayout } from "./dailyGrid";

export function eventWorkDate(eventStart: string, tz: string): string {
  return localDateString(eventStart, tz);
}

export async function loadPayrollEventTipPayouts(
  supabase: SupabaseClient,
  period: { start_date: string; end_date: string },
): Promise<EventTipPayout[]> {
  const tz = await getBreweryTimezone();
  // A day of slack either side: the filter is on the UTC timestamp, the day
  // is decided in brewery-local time below.
  const { data, error } = await supabase
    .from("event_tip_payouts")
    .select("employee_id, amount_cents, events!inner(event_start)")
    .eq("method", "payroll")
    .gte("events.event_start", `${addDaysStr(period.start_date, -1)}T00:00:00Z`)
    .lte("events.event_start", `${addDaysStr(period.end_date, 1)}T23:59:59Z`);
  if (error) throw new Error(`event tip payouts: ${error.message}`);
  const out: EventTipPayout[] = [];
  for (const raw of data ?? []) {
    const row = raw as unknown as { employee_id: string | null; amount_cents: number; events: { event_start: string } | null };
    if (!row.employee_id || !row.events) continue;
    const work_date = eventWorkDate(row.events.event_start, tz);
    if (work_date < period.start_date || work_date > period.end_date) continue;
    out.push({ employee_id: row.employee_id, work_date, amount_cents: row.amount_cents });
  }
  return out;
}
