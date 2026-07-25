/**
 * Approve/archive a single brand asset. Admin-only — approving flips the
 * asset live for `resolveAsset` consumers (guide viewer, etc.), archiving
 * removes it from consideration without deleting the Storage object.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { approveAsset, archiveAsset, type SupabaseLikeClient } from "@/lib/brand/assets";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(CAP.brandWorkbenchManage); // admin only
  } catch (res) {
    return res as Response;
  }

  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;

    if (body.action === "approve") {
      await approveAsset(supabase, id);
    } else if (body.action === "archive") {
      await archiveAsset(supabase, id);
    } else {
      return NextResponse.json({ error: "action must be 'approve' or 'archive'" }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
