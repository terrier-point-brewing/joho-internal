/**
 * Single brand template. PATCH with `{action:"publish"}` archives the prior
 * published version and flips this one; `{action:"draft-next"}` opens version
 * N+1 as a draft; otherwise the body is applied as a field patch.
 *
 * There is no way to edit a published template in place, deliberately: outputs
 * point at (template_id, template_version), so rewriting a published version
 * would silently change what an already-shipped artifact claims it was made
 * from. A change always starts a new version.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  draftNextVersion,
  publishTemplate,
  updateTemplate,
  type SupabaseLikeClient,
} from "@/lib/brand/templates";

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

    if (body.action === "publish") {
      await publishTemplate(supabase, id);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "draft-next") {
      return NextResponse.json(await draftNextVersion(supabase, id), { status: 201 });
    }

    const { action: _action, ...patch } = body;
    await updateTemplate(supabase, id, patch as never);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Validation failures carry the list of problems and are the caller's to
    // fix; storage failures are ours.
    if (err instanceof Error && !/^Failed/.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return apiError(err);
  }
}
