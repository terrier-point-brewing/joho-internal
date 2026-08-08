/**
 * Brand asset library — admin-gated list + upload. GET lists rows (optionally
 * filtered by `?kind=`) for the admin asset-library UI; public/approved reads
 * for guide rendering go through `resolveAsset` directly, not this route.
 * POST accepts multipart/form-data (field "file", "kind", optional "variant")
 * and uploads to the public `brand-assets` Storage bucket via the
 * service-role admin client before inserting the `brand_assets` row — mirrors
 * `lib/tax/files.ts:uploadTaskFile`'s upload-then-insert ordering.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  listAssets,
  createAsset,
  BRAND_ASSET_KINDS,
  MARK_SHAPES,
  MARK_ORIENTATIONS,
  normalizeVariant,
  type BrandAssetKind,
  type MarkShape,
  type MarkOrientation,
  type SupabaseLikeClient,
} from "@/lib/brand/assets";

export const dynamic = "force-dynamic";

const BUCKET = "brand-assets";

/** A trimmed form field, or null when absent/blank. */
function text(formData: FormData, field: string): string | null {
  const raw = formData.get(field);
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export async function GET(req: NextRequest) {
  try {
    await requirePermission(CAP.brandAssetsRead); // admin only
  } catch (res) {
    return res as Response;
  }

  try {
    const kind = new URL(req.url).searchParams.get("kind") as BrandAssetKind | null;
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    const assets = await listAssets(supabase, kind ? { kind } : undefined);
    return NextResponse.json(assets);
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requirePermission(CAP.brandAssetsManage); // admin only
  } catch (res) {
    return res as Response;
  }

  try {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    const kind = formData.get("kind");
    if (typeof kind !== "string" || !(BRAND_ASSET_KINDS as readonly string[]).includes(kind)) {
      return NextResponse.json(
        { error: `kind must be one of: ${BRAND_ASSET_KINDS.join(", ")}` },
        { status: 400 },
      );
    }
    // Normalized, not trusted as typed: the slug groups a variation's files
    // onto one card, so "Square Paper" and "square-paper" have to be the same
    // slug rather than two cards that look like a bug.
    const variantRaw = formData.get("variant");
    const variant = normalizeVariant(typeof variantRaw === "string" ? variantRaw : null);

    // Human metadata, both optional. `title` names the asset in pickers, which
    // otherwise show a storage variant; `alt_text` is the description a screen
    // reader gets, and only whoever uploaded the file knows what it depicts.
    const title = text(formData, "title");
    const altText = text(formData, "alt_text");

    // Mark facets — what the guide's Marks cards are built from. All optional:
    // they are meaningless on a texture or a photo, and a chop with no season
    // is the generic one rather than an incomplete one.
    const shapeRaw = text(formData, "shape");
    if (shapeRaw && !(MARK_SHAPES as readonly string[]).includes(shapeRaw)) {
      return NextResponse.json(
        { error: `shape must be one of: ${MARK_SHAPES.join(", ")}` },
        { status: 400 },
      );
    }
    const orientationRaw = text(formData, "orientation");
    if (orientationRaw && !(MARK_ORIENTATIONS as readonly string[]).includes(orientationRaw)) {
      return NextResponse.json(
        { error: `orientation must be one of: ${MARK_ORIENTATIONS.join(", ")}` },
        { status: 400 },
      );
    }

    // Derive a format/extension from the file name, falling back to the MIME
    // subtype (e.g. "image/svg+xml" -> "svg") when the name has none.
    const extFromName = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
    const extFromType = file.type ? file.type.split("/").pop()!.split("+")[0].toLowerCase() : "";
    const format = extFromName || extFromType || "bin";
    const storagePath = `${kind}/${crypto.randomUUID()}.${format}`;

    const admin = createSupabaseAdminClient();
    const { error: uploadError } = await admin.storage.from(BUCKET).upload(storagePath, file);
    if (uploadError) throw new Error(uploadError.message);

    const asset = await createAsset(admin as unknown as SupabaseLikeClient, {
      kind: kind as BrandAssetKind,
      variant,
      storage_path: storagePath,
      format,
      file_meta: { bytes: file.size, mime: file.type },
      title,
      alt_text: altText,
      season_id: text(formData, "season_id"),
      description: text(formData, "description"),
      shape: shapeRaw as MarkShape | null,
      color_treatment: text(formData, "color_treatment"),
      background: text(formData, "background"),
      orientation: orientationRaw as MarkOrientation | null,
    });
    return NextResponse.json(asset, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
