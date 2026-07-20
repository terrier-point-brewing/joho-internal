import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchOpenPhantomAlerts, fetchEligibleBatches } from "@/lib/production/phantomExportAlerts";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// GET /api/production/taproom-consumption/phantom-alerts
// Open phantom draft-swap alerts (taproom keg swaps that booked barrel excise
// with no cold-storage stock), each with the cold-storage batches now eligible
// to reconcile it. Drives the Export Bay "swaps with missing stock" list.
export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  try {
    const alerts = await fetchOpenPhantomAlerts(supabase);
    const withBatches = await Promise.all(
      alerts.map(async (alert) => ({ ...alert, eligibleBatches: await fetchEligibleBatches(supabase, alert) })),
    );
    return NextResponse.json({ alerts: withBatches });
  } catch (err) {
    return apiError(err);
  }
}
