import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getDraft, saveDraft, type SupabaseLikeClient } from "@/lib/brand/canonWorkflow";

export const dynamic = "force-dynamic";

// Canon editing is admin-only — the draft is the working copy behind the
// published guide/tokens, so reads and writes both require requireRole([]).
export async function GET() {
  try {
    await requireRole([]); // admin only
  } catch (res) {
    return res as Response;
  }

  try {
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    const draft = await getDraft(supabase);
    return NextResponse.json(draft);
  } catch (err) {
    return apiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    await requireRole([]); // admin only
  } catch (res) {
    return res as Response;
  }

  try {
    const body = await req.json();
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    await saveDraft(supabase, body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
