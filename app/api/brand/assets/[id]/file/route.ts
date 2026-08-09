/**
 * Brand asset bytes — session-gated proxy for the private `brand-assets`
 * bucket.
 *
 * The bucket went private in migration 20260903: nothing brand-related is
 * served to unauthenticated users, and a future public site will get its own
 * public bucket for the subset that should be exposed. Every image, mark and
 * font file therefore comes through here.
 *
 * A proxy rather than a signed URL, deliberately — see assetFileUrl(). Signed
 * URLs expire, which breaks `@font-face` sources, cached RSC payloads, and
 * stable download links.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

const BUCKET = "brand-assets";

// Fallback when a row carries no recorded MIME type (older uploads recorded
// only `format`). Anything unlisted is served as a generic binary rather than
// being guessed at.
const MIME_BY_FORMAT: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(CAP.brandAssetsRead);
  } catch (res) {
    return res as Response;
  }

  try {
    const { id } = await params;
    const admin = createSupabaseAdminClient();

    const { data: rows, error } = await admin
      .from("brand_assets")
      .select("storage_path, format, file_meta")
      .eq("id", id)
      .limit(1);
    // Supabase resolves with { error } rather than throwing, so an unchecked
    // call looks exactly like a successful one.
    if (error) throw new Error(error.message);

    const asset = rows?.[0];
    if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

    const { data: blob, error: downloadError } = await admin.storage
      .from(BUCKET)
      .download(asset.storage_path);
    if (downloadError || !blob) {
      return NextResponse.json({ error: "Asset file not found" }, { status: 404 });
    }

    // The recorded MIME came from the uploader's browser, so it is a fallback
    // and not the answer: `format` is validated against a per-kind allowlist at
    // upload, and serving those bytes as whatever the client claimed they were
    // is how an "image" ends up executing as something else.
    const recordedMime = (asset.file_meta as { mime?: unknown } | null)?.mime;
    const contentType =
      MIME_BY_FORMAT[String(asset.format).toLowerCase()] ||
      (typeof recordedMime === "string" && recordedMime) ||
      "application/octet-stream";

    return new NextResponse(blob, {
      headers: {
        "Content-Type": contentType,
        // `private` matters: these bytes are session-gated and must never land
        // in a shared/CDN cache.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    return apiError(err);
  }
}
