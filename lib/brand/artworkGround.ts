import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { BrandAsset } from "./assets";
import { groundForLuminance, luminanceForSvg, type ArtworkGround, type ArtworkLuminance } from "./svgColor";

const BUCKET = "brand-assets";

/** A variation is one drawing; (kind, variant) is what identifies it. */
const variationKey = (asset: BrandAsset) => `${asset.kind}::${asset.variant}`;

/**
 * Reads each variation's artwork and decides which ground keeps it legible.
 *
 * Measured from the SVG, then applied to every file of the same variation. The
 * SVG and the PNG under one variant are the same drawing, so measuring only the
 * file that happens to be readable and letting the others fall back to the
 * default surface meant the box changed colour when you flipped the format
 * switch — the PNG of a pale wordmark went back to rendering as an empty box.
 *
 * Done at render rather than at upload so assets uploaded before this existed
 * are covered without anyone re-uploading them. Safe to repeat: an asset row is
 * immutable once written (a replacement is a new row with a new id), so the
 * answer for a given id never changes.
 *
 * A variation that ships only as a raster gets no entry at all. Decoding a PNG
 * server-side would mean an image library for a background choice; the viewer
 * measures those off a canvas instead (see MarkArtwork), which is free because
 * it has already downloaded and decoded the file to show it.
 */
export async function groundsForAssets(
  assets: BrandAsset[],
): Promise<Map<string, ArtworkGround>> {
  const svgs = assets.filter((a) => a.format.toLowerCase() === "svg");
  if (svgs.length === 0) return new Map();

  const admin = createSupabaseAdminClient();

  const measured = await Promise.all(
    svgs.map(async (asset): Promise<[string, ArtworkLuminance | null]> => {
      try {
        const { data, error } = await admin.storage.from(BUCKET).download(asset.storage_path);
        if (error || !data) return [variationKey(asset), null];
        return [variationKey(asset), luminanceForSvg(await data.text())];
      } catch {
        // A background choice is never worth failing a page render over.
        return [variationKey(asset), null];
      }
    }),
  );

  // Keyed by variation, so a variation whose SVG failed to download still picks
  // up the answer from another SVG under the same variant rather than losing it.
  const byVariation = new Map<string, ArtworkLuminance>();
  for (const [key, stats] of measured) {
    if (stats && !byVariation.has(key)) byVariation.set(key, stats);
  }

  const out = new Map<string, ArtworkGround>();
  for (const asset of assets) {
    const stats = byVariation.get(variationKey(asset));
    if (stats) out.set(asset.id, groundForLuminance(stats));
  }
  return out;
}
