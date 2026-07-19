import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reconcilePhantomExport, PhantomReconcileError } from "@/lib/production/reconcilePhantom";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// POST /api/production/taproom-consumption/reconcile-phantom
// Body: { exportTransactionId, batchId }
// Retroactively depletes the chosen cold-storage batch for a phantom draft-swap
// export (the depletion that never happened) and acknowledges the alert. Writes
// no new excise — the phantom row already carries it.
export async function POST(req: NextRequest) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  let body: { exportTransactionId?: string; batchId?: string };
  try { body = await req.json(); } catch { return apiError("Invalid JSON body.", 400); }
  const { exportTransactionId, batchId } = body;
  if (!exportTransactionId || !batchId) return apiError("exportTransactionId and batchId are required.", 400);

  const supabase = await createSupabaseServerClient();
  try {
    await reconcilePhantomExport(supabase, { exportTransactionId, batchId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PhantomReconcileError) return apiError(err, 400);
    return apiError(err);
  }
}
