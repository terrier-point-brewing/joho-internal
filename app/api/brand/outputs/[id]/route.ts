/**
 * Single brand output — the review gate.
 *
 * `{action:"approve"}` needs `brand.outputs:manage`, which is a strictly higher
 * grant than the `operate` that created the draft. That gap is the gate: an
 * agent (or an automated caller) can produce work and cannot bless it.
 *
 * Export is refused on anything not already approved, in lib/brand/outputs.ts
 * rather than here, so the rule holds for every caller and not only this route.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { approveOutput, markExported, type SupabaseLikeClient } from "@/lib/brand/outputs";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(CAP.brandOutputsManage);
  } catch (res) {
    return res as Response;
  }

  const { id } = await context.params;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      renderedPath?: string;
    };
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;

    if (body.action === "approve") {
      await approveOutput(supabase, id);
      return NextResponse.json({ ok: true });
    }

    if (body.action === "export") {
      if (!body.renderedPath) {
        return NextResponse.json({ error: "renderedPath is required" }, { status: 400 });
      }
      await markExported(supabase, id, body.renderedPath);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'action must be "approve" or "export"' }, { status: 400 });
  } catch (err) {
    // "Cannot export an output that is draft" is the caller's mistake to fix.
    if (err instanceof Error && /^Cannot export/.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return apiError(err);
  }
}
