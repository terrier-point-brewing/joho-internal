import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reconcilePhantomExport, PhantomReconcileError } from "@/lib/production/reconcilePhantom";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// POST /api/production/taproom-consumption/reconcile-phantom
// Body: { exportTransactionId, variationId, batchId }
// Retroactively depletes the operator-chosen cold-storage lot (variation +
// batch) for a phantom draft-swap export (the depletion that never happened) and
// acknowledges the alert, correcting the record's variation when it differs from
// what was booked. Writes no new excise — the phantom row already carries it.
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.taproomPerformanceOperate); } catch (res) { return res as Response; }

  let body: { exportTransactionId?: string; variationId?: string; batchId?: string };
  try { body = await req.json(); } catch { return apiError("Invalid JSON body.", 400); }
  const { exportTransactionId, variationId, batchId } = body;
  if (!exportTransactionId || !variationId || !batchId) {
    return apiError("exportTransactionId, variationId and batchId are required.", 400);
  }

  const supabase = await createSupabaseServerClient();
  try {
    await reconcilePhantomExport(supabase, { exportTransactionId, variationId, batchId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PhantomReconcileError) return apiError(err, 400);
    return apiError(err);
  }
}
