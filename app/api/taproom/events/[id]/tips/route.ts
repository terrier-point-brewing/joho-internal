// app/api/taproom/events/[id]/tips/route.ts
//
// How an event's tips are settled. Event tips never enter the taproom tip
// pool (lib/square/payroll.ts carves every event ticket's tip out at source),
// so they must be settled here, one row per payee:
//
//   employee + payroll  -> lands on that employee's Paycheck Tips for the
//                          event's day (lib/payroll/eventTipPayouts.ts);
//                          refused once that pay period is locked.
//   anyone + cash/comp/other -> settled outside payroll on `settled_on`;
//                          relieves GL 2310 through eventTipSettlements.
//
// Volunteers can only be settled outside payroll. A payroll payout can only
// name an active hourly tipped employee — salaried staff never receive tips.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";
import { eventWorkDate } from "@/lib/payroll/eventTipPayouts";
import { addDaysStr } from "@/lib/utils/datetime";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { bookCompTipRevenue } from "@/lib/taproom/eventTipRevenue";
import { fetchShiftsByDay } from "@/lib/square/labor";

export const dynamic = "force-dynamic";

export type EventTipMethod = "payroll" | "cash" | "comp" | "other";
export const EVENT_TIP_METHODS: EventTipMethod[] = ["payroll", "cash", "comp", "other"];

export interface EventTipPayoutRow {
  id: string;
  payee_kind: "employee" | "volunteer";
  employee_id: string | null;
  payee_name: string;
  method: EventTipMethod;
  amount_cents: number;
  settled_on: string | null;
  note: string | null;
  created_at: string;
  /** Hours the employee worked at the event (kept out of the taproom pool that day). */
  event_hours: number | null;
  /** For comp: the manual_entries row booking the kept tip as event revenue. */
  manual_entry_id: string | null;
  /** The pay period the event's day falls in, when one exists. */
  pay_period: { id: string; start_date: string; end_date: string; status: string } | null;
}

export interface EventTipEmployee {
  id: string;
  name: string;
  /** Active hourly tipped employee: the only kind a payroll payout can name. */
  payroll_eligible: boolean;
  /** Hours Square clocked for them on the event's day (null = no shift / not on Square). */
  clocked_hours: number | null;
  /** Of those, hours already given to events that day (this one or another). */
  allocated_hours: number;
}

export interface EventTipsData {
  work_date: string;
  pay_period: EventTipPayoutRow["pay_period"];
  payouts: EventTipPayoutRow[];
  employees: EventTipEmployee[];
  total_paid_cents: number;
}

type Db = Awaited<ReturnType<typeof createSupabaseServerClient>>;

async function loadEvent(supabase: Db, id: string) {
  const { data, error } = await supabase.from("events").select("id, event_name, event_start").eq("id", id).single();
  if (error || !data) return null;
  return data as { id: string; event_name: string; event_start: string };
}

async function periodFor(supabase: Db, workDate: string): Promise<EventTipPayoutRow["pay_period"]> {
  const { data } = await supabase
    .from("pay_periods")
    .select("id, start_date, end_date, status")
    .lte("start_date", workDate)
    .gte("end_date", workDate)
    .limit(1)
    .maybeSingle();
  return (data as EventTipPayoutRow["pay_period"]) ?? null;
}

/**
 * Active employees with what Square clocked them for on `workDate` and how
 * many of those hours are already given to events that day — so the form can
 * show "9.73h clocked, 0h allocated" and the route can cap a new allocation.
 */
async function loadEmployees(supabase: Db, workDate: string): Promise<EventTipEmployee[]> {
  const [{ data }, shifts, { data: allocated }] = await Promise.all([
    supabase
      .from("employees")
      .select("id, first_name, last_name, employment_type, receives_tips, active, square_team_member_id")
      .eq("active", true)
      .order("last_name"),
    fetchShiftsByDay(workDate, workDate).catch(() => []),
    supabase
      .from("event_tip_payouts")
      .select("employee_id, event_hours, events!inner(event_start)")
      .eq("payee_kind", "employee")
      .gt("event_hours", 0)
      .gte("events.event_start", `${addDaysStr(workDate, -1)}T00:00:00Z`)
      .lte("events.event_start", `${addDaysStr(workDate, 1)}T23:59:59Z`),
  ]);
  const tz = await getBreweryTimezone();
  const clockedBySq = new Map<string, number>();
  for (const sh of shifts) if (sh.date === workDate) clockedBySq.set(sh.team_member_id, (clockedBySq.get(sh.team_member_id) ?? 0) + sh.hours);
  const allocatedByEmp = new Map<string, number>();
  for (const raw of allocated ?? []) {
    const a = raw as unknown as { employee_id: string; event_hours: number | string; events: { event_start: string } };
    if (eventWorkDate(a.events.event_start, tz) !== workDate) continue;
    allocatedByEmp.set(a.employee_id, (allocatedByEmp.get(a.employee_id) ?? 0) + Number(a.event_hours));
  }
  type Row = { id: string; first_name: string; last_name: string; employment_type: string; receives_tips: boolean; active: boolean; square_team_member_id: string | null };
  return ((data ?? []) as Row[]).map(e => ({
    id: e.id,
    name: `${e.first_name} ${e.last_name}`,
    payroll_eligible: e.employment_type === "hourly" && e.receives_tips && e.square_team_member_id != null,
    clocked_hours: e.square_team_member_id ? (clockedBySq.get(e.square_team_member_id) ?? 0) : null,
    allocated_hours: allocatedByEmp.get(e.id) ?? 0,
  }));
}

async function buildResponse(supabase: Db, eventId: string, eventStart: string): Promise<EventTipsData> {
  const tz = await getBreweryTimezone();
  const work_date = eventWorkDate(eventStart, tz);
  const [pay_period, employees, { data: rows, error }] = await Promise.all([
    periodFor(supabase, work_date),
    loadEmployees(supabase, work_date),
    supabase
      .from("event_tip_payouts")
      .select("id, payee_kind, employee_id, payee_name, method, amount_cents, settled_on, note, created_at, event_hours, manual_entry_id, employees(first_name, last_name)")
      .eq("event_id", eventId)
      .order("created_at", { ascending: true }),
  ]);
  if (error) throw new Error(error.message);
  type Raw = Omit<EventTipPayoutRow, "payee_name" | "pay_period" | "event_hours"> & { payee_name: string | null; event_hours: number | string | null; employees: { first_name: string; last_name: string } | null };
  const payouts: EventTipPayoutRow[] = ((rows ?? []) as unknown as Raw[]).map(r => ({
    id: r.id, payee_kind: r.payee_kind, employee_id: r.employee_id,
    payee_name: r.employees ? `${r.employees.first_name} ${r.employees.last_name}` : (r.payee_name ?? ""),
    method: r.method, amount_cents: r.amount_cents, settled_on: r.settled_on, note: r.note, created_at: r.created_at,
    event_hours: r.event_hours == null ? null : Number(r.event_hours),
    manual_entry_id: r.manual_entry_id ?? null,
    // Hours move the pool too, so any employee payout with hours is bound to the period.
    pay_period: r.method === "payroll" || Number(r.event_hours ?? 0) > 0 ? pay_period : null,
  }));
  return {
    work_date, pay_period, payouts, employees,
    total_paid_cents: payouts.reduce((s, p) => s + p.amount_cents, 0),
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.taproomPerformanceRead); } catch (res) { return res as Response; }
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const event = await loadEvent(supabase, id);
  if (!event) return apiError("Event not found", 404);
  try {
    return NextResponse.json(await buildResponse(supabase, id, event.event_start));
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let session;
  try { session = await requirePermission(CAP.taproomPerformanceOperate); } catch (res) { return res as Response; }
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const event = await loadEvent(supabase, id);
  if (!event) return apiError("Event not found", 404);

  const body = await req.json().catch(() => null) as {
    payee_kind?: unknown; employee_id?: unknown; payee_name?: unknown; method?: unknown;
    amount_cents?: unknown; settled_on?: unknown; note?: unknown; event_hours?: unknown;
  } | null;
  if (!body) return apiError("Invalid body", 400);

  const payee_kind = body.payee_kind === "employee" ? "employee" : body.payee_kind === "volunteer" ? "volunteer" : null;
  if (!payee_kind) return apiError("payee_kind must be employee or volunteer", 400);
  const method = EVENT_TIP_METHODS.find(m => m === body.method) ?? null;
  if (!method) return apiError("method must be payroll, cash, comp or other", 400);
  const amount_cents = typeof body.amount_cents === "number" && Number.isInteger(body.amount_cents) ? body.amount_cents : NaN;
  if (!(amount_cents > 0)) return apiError("amount_cents must be a positive whole number of cents", 400);
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  const tz = await getBreweryTimezone();
  const work_date = eventWorkDate(event.event_start, tz);

  let employee_id: string | null = null;
  let payee_name: string | null = null;
  let event_hours: number | null = null;
  if (payee_kind === "employee") {
    employee_id = typeof body.employee_id === "string" ? body.employee_id : null;
    if (!employee_id) return apiError("employee_id is required for an employee payout", 400);
    const emp = (await loadEmployees(supabase, work_date)).find(e => e.id === employee_id);
    if (!emp) return apiError("That employee is not active", 422);
    if (method === "payroll" && !emp.payroll_eligible) {
      return apiError(`${emp.name} cannot receive tips through payroll (not an hourly tipped employee). Settle this share in cash, as a comp, or another way.`, 422);
    }
    // Hours at the event come out of the day's clocked hours for pool
    // attribution. Cap at what is left after other events that day, with a
    // minute of slack for rounding on the display.
    if (body.event_hours != null && body.event_hours !== "") {
      const h = typeof body.event_hours === "number" ? body.event_hours : Number(body.event_hours);
      if (!Number.isFinite(h) || h < 0) return apiError("event_hours must be zero or more", 400);
      if (h > 0) {
        if (!emp.payroll_eligible) return apiError(`${emp.name} is not in the taproom tip pool, so there are no pool hours to set aside.`, 422);
        const available = Math.max(0, (emp.clocked_hours ?? 0) - emp.allocated_hours);
        if (h > available + 1 / 60) {
          return apiError(`${emp.name} has ${available.toFixed(2)}h available on ${work_date} (${(emp.clocked_hours ?? 0).toFixed(2)}h clocked on Square, ${emp.allocated_hours.toFixed(2)}h already given to events).`, 422);
        }
        event_hours = Math.round(Math.min(h, available) * 100) / 100;
      }
    }
  } else {
    payee_name = typeof body.payee_name === "string" ? body.payee_name.trim() : "";
    if (!payee_name) return apiError("A volunteer's name is required", 400);
    if (method === "payroll") return apiError("A volunteer is not on payroll. Settle their share in cash, as a comp, or another way.", 422);
  }

  let settled_on: string | null = null;
  if (method === "payroll" || (event_hours ?? 0) > 0) {
    // The payout lands in the pay period holding the event's day — the cents
    // on the paycheck, the hours in the pool attribution. Once that period is
    // locked its snapshot is frozen; a new row would silently never apply.
    const period = await periodFor(supabase, work_date);
    if (period?.status === "locked") {
      return NextResponse.json(
        { error: `The pay period for ${work_date} is locked. ${method === "payroll" ? "Settle this share outside payroll, or pay it as an adjustment on the open period." : "Record the payout without event hours."}` },
        { status: 409 },
      );
    }
  }
  if (method !== "payroll") {
    settled_on = typeof body.settled_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.settled_on) ? body.settled_on : work_date;
  }

  // Comped beer: the business keeps the tip money, so it is event revenue.
  // Booked first, through the service role (the taproom role has no
  // finance.transactions grant), so a payout never exists without its
  // revenue side. The payout row carries the entry id for reversal.
  let manual_entry_id: string | null = null;
  if (method === "comp") {
    try {
      manual_entry_id = await bookCompTipRevenue(createSupabaseAdminClient(), {
        eventName: event.event_name, amountCents: amount_cents, settledOn: settled_on!, note, userId: session.user.id,
      });
    } catch (err) {
      return apiError(err);
    }
  }

  const { error } = await supabase.from("event_tip_payouts").insert({
    event_id: id, payee_kind, employee_id, payee_name, method, amount_cents, settled_on, note,
    event_hours, manual_entry_id, created_by: session.user.id,
  });
  if (error) {
    if (manual_entry_id) await createSupabaseAdminClient().from("manual_entries").delete().eq("id", manual_entry_id);
    return apiError(error.message);
  }

  try {
    return NextResponse.json(await buildResponse(supabase, id, event.event_start), { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
