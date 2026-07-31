/**
 * Approve/archive a single brand asset. Admin-only — approving flips the
 * asset live for `resolveAsset` consumers (guide viewer, etc.), archiving
 * removes it from consideration without deleting the Storage object.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  approveAsset,
  archiveAsset,
  updateAssetMeta,
  type SupabaseLikeClient,
} from "@/lib/brand/assets";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(CAP.brandAssetsManage); // admin only
  } catch (res) {
    return res as Response;
  }

  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      title?: string;
      alt_text?: string;
    };
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;

    if (body.action === "approve") {
      await approveAsset(supabase, id);
    } else if (body.action === "archive") {
      await archiveAsset(supabase, id);
    } else if (body.title !== undefined || body.alt_text !== undefined) {
      // Metadata is editable at any point in an asset's life — re-uploading a
      // file just to name it is not a reasonable ask of a growing library.
      await updateAssetMeta(supabase, id, { title: body.title, alt_text: body.alt_text });
    } else {
      return NextResponse.json(
        { error: "expected action 'approve'/'archive', or a title/alt_text to update" },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
