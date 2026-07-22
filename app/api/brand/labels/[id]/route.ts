/**
 * Single brand label — admin-gated read, update, approve/archive. GET
 * returns the row; PATCH with `{action:"approve"|"archive"}` flips status,
 * otherwise the body is applied as a field patch via `updateLabel`. Mirrors
 * `app/api/brand/assets/[id]/route.ts`.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { approveLabel, archiveLabel, getLabel, updateLabel, type SupabaseLikeClient } from "@/lib/brand/labels";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireRole([]); // admin only
  } catch (res) {
    return res as Response;
  }

  const { id } = await context.params;
  try {
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    const label = await getLabel(supabase, id);
    if (!label) {
      return NextResponse.json({ error: "Label not found" }, { status: 404 });
    }
    return NextResponse.json(label);
  } catch (err) {
    return apiError(err);
  }
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireRole([]); // admin only
  } catch (res) {
    return res as Response;
  }

  const { id } = await context.params;
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; [key: string]: unknown };
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;

    if (body.action === "approve") {
      await approveLabel(supabase, id);
    } else if (body.action === "archive") {
      await archiveLabel(supabase, id);
    } else {
      const { action: _action, ...patch } = body;
      await updateLabel(supabase, id, patch);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
