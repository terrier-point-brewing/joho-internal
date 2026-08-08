/**
 * Approve/archive/delete a single brand asset. Admin-only — approving flips the
 * asset live for `resolveAsset` consumers (guide viewer, etc.), archiving
 * removes it from consideration without deleting the Storage object.
 *
 * DELETE is the one irreversible action here, and takes the row AND the bytes.
 * It is reachable only from the archived state and only when nothing still
 * references the asset — see deleteAsset() for why both gates are needed.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  approveAsset,
  archiveAsset,
  deleteAsset,
  updateAssetMeta,
  MARK_SHAPES,
  MARK_ORIENTATIONS,
  type MarkFacets,
  type SupabaseLikeClient,
} from "@/lib/brand/assets";

export const dynamic = "force-dynamic";

const BUCKET = "brand-assets";

/** Every field this route lets a caller rewrite, besides approve/archive. */
const META_FIELDS = [
  "variant",
  "title",
  "alt_text",
  "season_id",
  "description",
  "shape",
  "color_treatment",
  "background",
  "orientation",
] as const;

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
      variant?: string;
      title?: string;
      alt_text?: string;
    } & MarkFacets;
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;

    if (body.action === "approve") {
      await approveAsset(supabase, id);
    } else if (body.action === "archive") {
      await archiveAsset(supabase, id);
    } else if (META_FIELDS.some((field) => body[field] !== undefined)) {
      // Metadata is editable at any point in an asset's life — re-uploading a
      // file just to name it is not a reasonable ask of a growing library, and
      // a chop uploaded before its season existed has to be able to join it.
      if (body.shape != null && !(MARK_SHAPES as readonly string[]).includes(body.shape)) {
        return NextResponse.json(
          { error: `shape must be one of: ${MARK_SHAPES.join(", ")}` },
          { status: 400 },
        );
      }
      if (
        body.orientation != null &&
        !(MARK_ORIENTATIONS as readonly string[]).includes(body.orientation)
      ) {
        return NextResponse.json(
          { error: `orientation must be one of: ${MARK_ORIENTATIONS.join(", ")}` },
          { status: 400 },
        );
      }
      const patch: Record<string, unknown> = {};
      for (const field of META_FIELDS) {
        if (body[field] !== undefined) patch[field] = body[field];
      }
      await updateAssetMeta(supabase, id, patch);
    } else {
      return NextResponse.json(
        { error: `expected action 'approve'/'archive', or one of: ${META_FIELDS.join(", ")}` },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(CAP.brandAssetsManage); // admin only
  } catch (res) {
    return res as Response;
  }

  const { id } = await params;
  try {
    const supabase = createSupabaseAdminClient();
    // Row first: it is what enforces the archived + unreferenced gates, and it
    // hands back the storage_path. Bytes second — an orphaned Storage object is
    // recoverable clutter, whereas a row pointing at bytes that are already gone
    // is a broken card in the library.
    const asset = await deleteAsset(supabase as unknown as Parameters<typeof deleteAsset>[0], id);
    await supabase.storage.from(BUCKET).remove([asset.storage_path]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
