import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchOpenPhantomAlerts, fetchLotOptions } from "@/lib/production/phantomExportAlerts";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// GET /api/production/taproom-consumption/phantom-alerts
// Open phantom alerts (taproom bookings that carried barrel excise with no
// cold-storage stock), each with the cold-storage lots (variation + batch) now
// eligible to resolve it. Drives the Export Bay "booked without cold-storage
// stock" list. Each alert carries an `origin` — draft_swap, keg_sale or
// can_sale — because the list mixes drained tap kegs with sales that outran
// stock, and only the first kind has a tap.
// Gated at `read`, not `operate`: this is the Export Bay reconciliation
// indicator, and brewer holds `production.export: operate` (so reaches the tab)
// but only `taproom.performance: read`. Gating the GET at `operate` 403'd every
// brewer, and the panel rendered that failure as "All reconciled" — a false
// all-clear for the majority of users. Resolve/dismiss stay at `operate`.
export async function GET() {
  try { await requirePermission(CAP.taproomPerformanceRead); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  try {
    const alerts = await fetchOpenPhantomAlerts(supabase);
    const withLots = await Promise.all(
      alerts.map(async (alert) => {
        const { eligible, alternatives } = await fetchLotOptions(supabase, alert);
        return { ...alert, eligibleLots: eligible, alternativeLots: alternatives };
      }),
    );
    return NextResponse.json({ alerts: withLots });
  } catch (err) {
    return apiError(err);
  }
}
