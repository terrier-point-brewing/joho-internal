import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { publishDraft, type SupabaseLikeClient } from "@/lib/brand/canonWorkflow";

export const dynamic = "force-dynamic";

// Publishing snapshots the draft as the new live canon version — admin-only.
//
// This is the one point where the whole canon is validated (section saves check
// only their own slice). A validation failure comes back through apiError as a
// subtab-grouped message naming what to fix and where, not a raw Zod dump.
export async function POST(req: NextRequest) {
  try {
    await requirePermission(CAP.brandGuideManage); // admin only
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
    // Bust getCanon()'s data cache so the new version shows immediately on the
    // guide + BrandStyle. Without this, publishing writes the DB row but the
    // cached canon keeps serving the old document.
    revalidateTag("brand-canon", "max");
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err);
  }
}
