import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { dismissPhantomExport, PhantomReconcileError } from "@/lib/production/reconcilePhantom";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// POST /api/production/taproom-consumption/dismiss-phantom
// Body: { exportTransactionId }
// Acknowledges a phantom draft-swap alert without any cold-storage depletion —
// for swaps where there genuinely was no keg in cold storage to draw down.
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.taproomPerformanceOperate); } catch (res) { return res as Response; }

  let body: { exportTransactionId?: string };
  try { body = await req.json(); } catch { return apiError("Invalid JSON body.", 400); }
  const { exportTransactionId } = body;
  if (!exportTransactionId) return apiError("exportTransactionId is required.", 400);

  const supabase = await createSupabaseServerClient();
  try {
    await dismissPhantomExport(supabase, { exportTransactionId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PhantomReconcileError) return apiError(err, 400);
    return apiError(err);
  }
}
