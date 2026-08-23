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
import { getCanon } from "@/lib/brand/getCanon";
import {
  activateSeason,
  canonTokenChoices,
  normalizeSeasonPalette,
  updateSeason,
  type SupabaseLikeClient,
} from "@/lib/brand/seasons";

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

      // A season SELECTS from the canon and never redefines it. The column's
      // CHECK constrains the palette's shape and deliberately not its
      // vocabulary — which token keys are legal is whatever the canon currently
      // declares — so the vocabulary is enforced here, against the live canon.
      // The editor only ever offers canon keys; this is what makes that a rule
      // rather than a convention, since the route forwards an arbitrary body.
      if ("palette" in patch) {
        patch.palette = normalizeSeasonPalette(patch.palette, canonTokenChoices(await getCanon()));
      }

      await updateSeason(supabase, id, patch as never);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    // A refused activation names what the season still needs and is the
    // caller's to fix; storage failures are ours. Same convention as the
    // templates routes.
    if (err instanceof Error && !/^Failed/.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return apiError(err);
  }
}
