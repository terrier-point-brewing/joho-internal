/**
 * Tax filing schedules — the recurring cadence (frequency, lead_days, active,
 * party-specific config) that drives `ensureTasksForSchedule` (Task 9's cron).
 * GET is manager+ (finance read); POST is admin-only and validates the
 * requested frequency against the party template's `supportedFrequencies`
 * before creating the row (deferred validation from Task 8).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listSchedules, createSchedule, type CreateScheduleInput } from "@/lib/tax/schedules";
import { getParty } from "@/lib/tax/registry";
// Side-effect import: registers every party template before getParty() runs.
import "@/lib/tax/parties";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  try {
    const { searchParams } = new URL(req.url);
    const sb = createSupabaseAdminClient();
    const schedules = await listSchedules(sb, {
      partyKey: searchParams.get("party") ?? undefined,
      activeOnly: searchParams.get("activeOnly") === "true",
    });
    return NextResponse.json(schedules);
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as CreateScheduleInput;
    const template = getParty(body.party_key);
    if (!template.supportedFrequencies.includes(body.frequency)) {
      return apiError(
        `${template.label} does not support frequency "${body.frequency}" (supported: ${template.supportedFrequencies.join(", ")})`,
        400,
      );
    }

    const sb = createSupabaseAdminClient();
    const schedule = await createSchedule(sb, body);
    return NextResponse.json(schedule, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
