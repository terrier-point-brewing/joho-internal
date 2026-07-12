/**
 * Single tax filing schedule — admin-only mutation. PATCH updates any subset
 * of frequency/lead_days/active/config; DELETE is a soft-delete
 * (`setScheduleActive(sb, id, false)`) so historical `tax_tasks` rows keep
 * their `schedule_id` foreign key intact.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { updateSchedule, setScheduleActive, type UpdateScheduleInput } from "@/lib/tax/schedules";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const { id } = await params;
  try {
    const patch = (await req.json()) as UpdateScheduleInput;
    const sb = createSupabaseAdminClient();
    const schedule = await updateSchedule(sb, id, patch);
    return NextResponse.json(schedule);
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const { id } = await params;
  try {
    const sb = createSupabaseAdminClient();
    const schedule = await setScheduleActive(sb, id, false);
    return NextResponse.json(schedule);
  } catch (err) {
    return apiError(err);
  }
}
