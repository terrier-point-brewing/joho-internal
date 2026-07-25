import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchOpenPhantomAlerts, fetchEligibleLots } from "@/lib/production/phantomExportAlerts";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// GET /api/production/taproom-consumption/phantom-alerts
// Open phantom draft-swap alerts (taproom keg swaps that booked barrel excise
// with no cold-storage stock), each with the same-size cold-storage lots
// (variation + batch) now eligible to resolve it. Drives the Export Bay "swaps
// with missing stock" list.
export async function GET() {
  try { await requirePermission(CAP.taproomPerformanceOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  try {
    const alerts = await fetchOpenPhantomAlerts(supabase);
    const withLots = await Promise.all(
      alerts.map(async (alert) => ({ ...alert, eligibleLots: await fetchEligibleLots(supabase, alert) })),
    );
    return NextResponse.json({ alerts: withLots });
  } catch (err) {
    return apiError(err);
  }
}
