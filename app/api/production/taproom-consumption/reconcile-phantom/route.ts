import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reconcilePhantomExport, transformForPhantomExport, PhantomReconcileError } from "@/lib/production/reconcilePhantom";
import { triggerSquarePush } from "@/lib/production/triggerSquarePush";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// POST /api/production/taproom-consumption/reconcile-phantom
// Body: { exportTransactionId, variationId, batchId } — resolve against a lot
//       { exportTransactionId, transformLotId }        — break a lot down first
// Retroactively depletes the operator-chosen cold-storage lot (variation +
// batch) for a phantom draft-swap export (the depletion that never happened) and
// acknowledges the alert, correcting the record's variation when it differs from
// what was booked. Writes no new excise — the phantom row already carries it.
//
// `transformLotId` is the wrong-shape route: when cold storage holds cases and a
// single can was rung, the named lot is broken down into the booked variation
// first and the reconcile then runs against the result. The unit counts are
// re-derived server-side, never read from the body.
//
// PERMISSIONS. Reconciling is `taproom.performance: operate`. A transform is
// `production.export: operate` — the same bar the standalone transform route
// sets, because it destroys inventory irreversibly. Doing one inside the other
// must clear BOTH: gating the pair at the reconcile's level alone would hand
// every taproom operator the destructive capability that was deliberately kept
// at export level.
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.taproomPerformanceOperate); } catch (res) { return res as Response; }

  let body: { exportTransactionId?: string; variationId?: string; batchId?: string; transformLotId?: string };
  try { body = await req.json(); } catch { return apiError("Invalid JSON body.", 400); }
  const { exportTransactionId, transformLotId } = body;
  let { variationId, batchId } = body;
  if (!exportTransactionId) return apiError("exportTransactionId is required.", 400);
  if (!transformLotId && (!variationId || !batchId)) {
    return apiError("variationId and batchId are required.", 400);
  }
  if (transformLotId) {
    try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }
  }

  const supabase = await createSupabaseServerClient();
  try {
    let recipeId: string | null = null;
    if (transformLotId) {
      const result = await transformForPhantomExport(supabase, { exportTransactionId, lotId: transformLotId });
      variationId = result.variationId;
      batchId = result.batchId;
      recipeId = result.recipeId;
    }
    await reconcilePhantomExport(supabase, { exportTransactionId, variationId: variationId!, batchId: batchId! });
    // Cold-storage counts moved in two ways here (a break, then a depletion);
    // restate Square for the recipe exactly as the transform route does. Never
    // throws, and no-ops while the push gate is shut.
    if (recipeId) await triggerSquarePush(supabase, [recipeId], "phantom reconcile transform");
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PhantomReconcileError) return apiError(err, 400);
    return apiError(err);
  }
}
