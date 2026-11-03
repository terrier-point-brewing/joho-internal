import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";
import { eventWorkDate } from "@/lib/payroll/eventTipPayouts";

export const dynamic = "force-dynamic";

/** Remove a payout that was recorded by mistake. A payroll payout whose pay
 *  period has locked is frozen in that snapshot and cannot be removed here. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; payoutId: string }> }) {
  try { await requirePermission(CAP.taproomPerformanceOperate); } catch (res) { return res as Response; }
  const { id, payoutId } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: row } = await supabase
    .from("event_tip_payouts")
    .select("id, method, events!inner(event_start)")
    .eq("id", payoutId).eq("event_id", id)
    .maybeSingle();
  if (!row) return apiError("Payout not found", 404);

  const r = row as unknown as { method: string; events: { event_start: string } };
  if (r.method === "payroll") {
    const work_date = eventWorkDate(r.events.event_start, await getBreweryTimezone());
    const { data: period } = await supabase
      .from("pay_periods").select("status")
      .lte("start_date", work_date).gte("end_date", work_date)
      .limit(1).maybeSingle();
    if ((period as { status?: string } | null)?.status === "locked") {
      return NextResponse.json({ error: "This payout is in a locked pay period. Correct it as an adjustment on the open period." }, { status: 409 });
    }
  }

  const { error } = await supabase.from("event_tip_payouts").delete().eq("id", payoutId);
  if (error) return apiError(error.message);
  return new NextResponse(null, { status: 204 });
}
