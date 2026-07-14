/**
 * Recompute a task's worksheet from source data (Square, currently — see
 * lib/tax/parties/ncDorSalesUse/calc.ts). Loads the task, its schedule, and
 * its party's filing profile; builds the `ComputeContext` the party template
 * needs; calls `party.computeWorksheet`; then reconciles the fresh values
 * with whatever's already saved via `party.mergeWorksheet` so in-progress
 * manual edits (penalty, interest, credits, ...) aren't clobbered.
 * Manager+ (same gate as the worksheet autosave route).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getTask, saveWorksheet } from "@/lib/tax/tasks";
import { getSchedule } from "@/lib/tax/schedules";
import { getProfile } from "@/lib/tax/profiles";
import { getParty } from "@/lib/tax/registry";
import { buildRateMap, listTaxRates } from "@/lib/tax/rates";
import type { ComputeContext } from "@/lib/tax/types";
// Side-effect import: registers every party template before getParty() runs.
import "@/lib/tax/parties";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const { id } = await params;
  try {
    const sb = createSupabaseAdminClient();

    const task = await getTask(sb, id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const schedule = await getSchedule(sb, task.schedule_id);
    if (!schedule) return NextResponse.json({ error: "Schedule not found" }, { status: 404 });

    const party = getParty(task.party_key);
    const profile = await getProfile(sb, task.party_key);

    const ctx: ComputeContext = {
      schedule,
      profile,
      period: { start: task.period_start, end: task.period_end, due: task.due_date },
    };

    const recomputed = await party.computeWorksheet(ctx);
    const rateMap = buildRateMap(await listTaxRates(sb));
    const merged = party.mergeWorksheet(task.worksheet ?? { fields: {} }, recomputed, rateMap);

    const saved = await saveWorksheet(sb, id, merged);
    return NextResponse.json(saved.worksheet);
  } catch (err) {
    return apiError(err);
  }
}
