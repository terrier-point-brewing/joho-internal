/**
 * Single brand season. PATCH with `{action:"activate"}` archives the outgoing
 * season and makes this one current; otherwise the body is a field patch.
 *
 * Activating is not a status dropdown because it is not a local edit: it is the
 * moment every `motif` slot in the system changes what it resolves to. One
 * deliberate action, exactly one winner (enforced by a partial unique index).
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { activateSeason, updateSeason, type SupabaseLikeClient } from "@/lib/brand/seasons";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(CAP.brandTemplatesManage);
  } catch (res) {
    return res as Response;
  }

  const { id } = await context.params;
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; [k: string]: unknown };
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;

    if (body.action === "activate") {
      await activateSeason(supabase, id);
    } else {
      const { action: _action, ...patch } = body;
      await updateSeason(supabase, id, patch as never);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
