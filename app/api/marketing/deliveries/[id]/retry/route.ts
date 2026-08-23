/**
 * Put one failed delivery back on the publishing queue.
 *
 * A person's decision, always — there are no automatic retries in marketing,
 * because a machine repeating a publish whose outcome it is unsure of is how
 * something gets posted twice, and you cannot un-post.
 *
 * The route is deliberately thin: `retryDelivery` owns the rule that only a
 * failed delivery may be re-queued, and owns the conditional update that makes
 * two people pressing the button at once safe. Everything here does is turn its
 * refusal into a status code.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { DeliveryRetryError, retryDelivery } from "@/lib/marketing/deliveries";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(CAP.marketingPublish);
  } catch (res) {
    return res as Response;
  }

  const { id } = await context.params;
  try {
    const delivery = await retryDelivery(createSupabaseAdminClient(), id);
    // The external ids come back so a caller can see they survived. They are
    // provider-side post ids, not credentials.
    return NextResponse.json({ ok: true, delivery });
  } catch (err) {
    if (err instanceof DeliveryRetryError) return apiError(err.message, err.status);
    return apiError(err);
  }
}
