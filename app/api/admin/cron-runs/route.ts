/**
 * GET /api/admin/cron-runs — admin-only. Returns the cron job registry plus the
 * most recent run history for the Settings → Cron Jobs monitor.
 */
import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { CRON_JOBS } from "@/lib/cron/registry";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.cronRead); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const { data: runs, error } = await supabase
    .from("cron_runs")
    .select("id, job, status, started_at, finished_at, duration_ms, detail, error")
    .order("started_at", { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ jobs: CRON_JOBS, runs: runs ?? [] });
}
