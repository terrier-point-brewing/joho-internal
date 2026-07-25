/**
 * Tax filing tasks list — one row per filing period. GET supports filtering
 * by status/schedule/party (mirrors `lib/tax/tasks.ts`'s `ListTasksFilter`).
 * Manager+ (finance read); tasks are created by the cron sync
 * (`ensureTasksForSchedule`, Task 9), not via this route.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listTasks } from "@/lib/tax/tasks";
import type { TaxTaskStatus } from "@/lib/tax/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.taxRead); } catch (res) { return res as Response; }

  try {
    const { searchParams } = new URL(req.url);
    const sb = createSupabaseAdminClient();
    const tasks = await listTasks(sb, {
      status: (searchParams.get("status") as TaxTaskStatus | null) ?? undefined,
      partyKey: searchParams.get("party") ?? undefined,
      scheduleId: searchParams.get("scheduleId") ?? undefined,
    });
    return NextResponse.json(tasks);
  } catch (err) {
    return apiError(err);
  }
}
