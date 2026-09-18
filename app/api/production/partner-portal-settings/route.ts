import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadTaproomBufferPct, TAPROOM_BUFFER_KEY } from "@/lib/partner/portal.server";

export const dynamic = "force-dynamic";

/**
 * The taproom's reserve: the share of every batch held back before any of the
 * taproom's allocation is offered to partners through the portal.
 */
export async function GET() {
  try { await requirePermission(CAP.productionSettingsManage); } catch (res) { return res as Response; }
  return NextResponse.json({ pct: await loadTaproomBufferPct(createSupabaseAdminClient()) });
}

export async function PUT(req: NextRequest) {
  try { await requirePermission(CAP.productionSettingsManage); } catch (res) { return res as Response; }
  const { pct } = await req.json() as { pct: number };
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return NextResponse.json({ error: "pct must be between 0 and 100" }, { status: 400 });
  }
  const { error } = await createSupabaseAdminClient().from("system_settings").upsert({ key: TAPROOM_BUFFER_KEY, value: pct });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ pct });
}
