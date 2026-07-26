/**
 * Single tax filing schedule — admin-only mutation. PATCH updates any subset
 * of frequency/lead_days/active/config, re-validating `frequency` (when
 * present in the patch) against the party template's `supportedFrequencies`
 * — mirrors the POST validation in ../route.ts so an admin can't PATCH a
 * schedule onto a frequency `computePeriod` doesn't support for that party.
 * DELETE is a soft-delete (`setScheduleActive(sb, id, false)`) so historical
 * `tax_tasks` rows keep their `schedule_id` foreign key intact.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getSchedule, updateSchedule, setScheduleActive, type UpdateScheduleInput } from "@/lib/tax/schedules";
import { getParty } from "@/lib/tax/registry";
import { validateDueRule } from "@/lib/tax/dueDate";
// Side-effect import: registers every party template before getParty() runs.
import "@/lib/tax/parties";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.taxManage); } catch (res) { return res as Response; }

  const { id } = await params;
  try {
    const patch = (await req.json()) as UpdateScheduleInput;
    const sb = createSupabaseAdminClient();

    if (patch.frequency) {
      const existing = await getSchedule(sb, id);
      if (!existing) return apiError("Schedule not found", 404);
      const template = getParty(existing.party_key);
      if (!template.supportedFrequencies.includes(patch.frequency)) {
        return apiError(
          `${template.label} does not support frequency "${patch.frequency}" (supported: ${template.supportedFrequencies.join(", ")})`,
          400,
        );
      }
    }

    const dueRule = (patch.config as Record<string, unknown> | undefined)?.dueRule;
    if (dueRule !== undefined) {
      const msg = validateDueRule(dueRule);
      if (msg) return apiError(msg, 400);
    }

    const schedule = await updateSchedule(sb, id, patch);
    return NextResponse.json(schedule);
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.taxManage); } catch (res) { return res as Response; }

  const { id } = await params;
  try {
    const sb = createSupabaseAdminClient();
    const schedule = await setScheduleActive(sb, id, false);
    return NextResponse.json(schedule);
  } catch (err) {
    return apiError(err);
  }
}
