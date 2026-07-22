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
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listAssets, createAsset, type BrandAssetKind, type SupabaseLikeClient } from "@/lib/brand/assets";

export const dynamic = "force-dynamic";

const BUCKET = "brand-assets";

export async function GET(req: NextRequest) {
  try {
    await requireRole([]); // admin only
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
    await requireRole([]); // admin only
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
    if (typeof kind !== "string" || !kind) {
      return NextResponse.json({ error: "kind required" }, { status: 400 });
    }
    const variantRaw = formData.get("variant");
    const variant = typeof variantRaw === "string" && variantRaw ? variantRaw : "default";

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
    });
    return NextResponse.json(asset, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
