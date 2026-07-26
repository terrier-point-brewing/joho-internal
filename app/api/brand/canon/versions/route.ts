import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listVersions, type SupabaseLikeClient } from "@/lib/brand/canonWorkflow";

export const dynamic = "force-dynamic";

// Version history (published + archived) — admin-only, same as draft/publish.
export async function GET() {
  try {
    await requirePermission(CAP.brandGuideManage); // admin only
  } catch (res) {
    return res as Response;
  }

  try {
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    const versions = await listVersions(supabase);
    return NextResponse.json(versions);
  } catch (err) {
    return apiError(err);
  }
}
