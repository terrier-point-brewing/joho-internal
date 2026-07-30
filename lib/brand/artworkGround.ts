import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { BrandAsset } from "./assets";
import { groundForSvg, type ArtworkGround } from "./svgColor";

const BUCKET = "brand-assets";

/**
 * Reads each SVG asset and decides which ground keeps it legible.
 *
 * Done at render rather than at upload so assets uploaded before this existed
 * are covered without anyone re-uploading them. Safe to repeat: an asset row is
 * immutable once written (a replacement is a new row with a new id), so the
 * answer for a given id never changes.
 *
 * Non-SVG formats return `neutral` without a fetch — reading dominant colour
 * out of a raster would mean decoding the image, which is a lot of work for a
 * background choice.
 */
export async function groundsForAssets(
  assets: BrandAsset[],
): Promise<Map<string, ArtworkGround>> {
  const svgs = assets.filter((a) => a.format.toLowerCase() === "svg");
  if (svgs.length === 0) return new Map();

  const admin = createSupabaseAdminClient();

  const entries = await Promise.all(
    svgs.map(async (asset): Promise<[string, ArtworkGround]> => {
      try {
        const { data, error } = await admin.storage.from(BUCKET).download(asset.storage_path);
        if (error || !data) return [asset.id, "neutral"];
        return [asset.id, groundForSvg(await data.text())];
      } catch {
        // A background choice is never worth failing a page render over.
        return [asset.id, "neutral"];
      }
    }),
  );

  return new Map(entries);
}
