import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { publishDraft, type SupabaseLikeClient } from "@/lib/brand/canonWorkflow";

export const dynamic = "force-dynamic";

// Publishing snapshots the draft as the new live canon version — admin-only.
export async function POST(req: NextRequest) {
  try {
    await requireRole([]); // admin only
  } catch (res) {
    return res as Response;
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      versionLabel?: string;
      changelog?: string;
    };
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    const result = await publishDraft(supabase, body);
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err);
  }
}
