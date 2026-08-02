/**
 * Marks — turning a flat list of approved assets into the cards the guide shows.
 *
 * The two mark families are grouped on different axes, because they vary on
 * different things:
 *
 *   Wordmarks are one drawing shipped many ways. Every variation is the same
 *   mark; what differs is its proportions, how it is colored, and whether it
 *   carries a ground. So they group by `variant` — one variation, one card —
 *   and the files under a variant (the SVG and the PNG of the same artwork) are
 *   two views of one card rather than two cards.
 *
 *   Chops are cut per season. Color and frame are fixed by the canon's chop
 *   specification; only the content rotates. So they group by season, with the
 *   seasonless ones standing as the generic fallback.
 *
 * Pure functions over rows — no client, no fetch — so the grouping rules are
 * testable without a database.
 */
import type { BrandAsset } from "./assets";
import type { BrandSeason } from "./seasons";

/** Formats an <img> renders. PDFs and archives are download-only. */
const DISPLAYABLE = new Set(["svg", "png", "jpg", "jpeg", "webp", "gif"]);

/** Display preference within a card: vector first, then raster, then the rest. */
const FORMAT_RANK: Record<string, number> = { svg: 0, png: 1, webp: 2, jpg: 3, jpeg: 3 };
const rankOf = (asset: BrandAsset) => FORMAT_RANK[asset.format.toLowerCase()] ?? 9;

/**
 * The file a card shows by default.
 *
 * A vector wins when one exists — it stays crisp at whatever size the card's
 * box resolves to, where a raster may not. Exported so the viewer and the
 * grouping agree on which file is "the" file.
 */
export function pickDisplayAsset(assets: BrandAsset[]): BrandAsset | null {
  const displayable = assets.filter((a) => DISPLAYABLE.has(a.format.toLowerCase()));
  if (displayable.length === 0) return null;
  return [...displayable].sort((a, b) => rankOf(a) - rankOf(b))[0];
}

/** One wordmark variation: its label, its facets, and every file it ships as. */
export interface MarkVariation {
  /** The `variant` slug the files share — stable, so it keys the React list. */
  key: string;
  /** What to call it on the card. */
  label: string;
  /** Every approved file for this variation, vector first. */
  files: BrandAsset[];
  /** The file shown when the card opens. Null when nothing is displayable. */
  display: BrandAsset | null;
  shape: BrandAsset["shape"];
  colorTreatment: string | null;
  background: string | null;
  /** When to reach for this variation. */
  description: string | null;
}

/**
 * The first non-empty value of a field across a variation's files.
 *
 * A variation is uploaded as two files, and whoever uploads them fills the
 * facets on one of them — usually the SVG, since it goes first. Reading only
 * the display file would blank the card when they were typed on the PNG.
 */
function firstDefined<T>(files: BrandAsset[], read: (a: BrandAsset) => T | null | undefined): T | null {
  for (const file of files) {
    const value = read(file);
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

/**
 * Groups mark assets into one card per variation.
 *
 * Order is the order the assets arrive in (the API lists newest first), keyed
 * off each variation's first-seen file, so the list doesn't reshuffle when a
 * second format is added to an existing variation.
 */
export function groupVariations(assets: BrandAsset[]): MarkVariation[] {
  const byVariant = new Map<string, BrandAsset[]>();
  for (const asset of assets) {
    const existing = byVariant.get(asset.variant);
    if (existing) existing.push(asset);
    else byVariant.set(asset.variant, [asset]);
  }

  return [...byVariant.entries()].map(([key, group]) => {
    const files = [...group].sort((a, b) => rankOf(a) - rankOf(b));
    return {
      key,
      // The title someone gave it wins over the storage slug; the slug is a
      // filing decision, not a name a reader should have to decode.
      label: firstDefined(files, (a) => a.title) ?? key,
      files,
      display: pickDisplayAsset(files),
      shape: firstDefined(files, (a) => a.shape),
      colorTreatment: firstDefined(files, (a) => a.color_treatment),
      background: firstDefined(files, (a) => a.background),
      description: firstDefined(files, (a) => a.description),
    };
  });
}

/** The chops belonging to one season, or the seasonless generic set. */
export interface ChopGroup {
  /** Null for the generic group. */
  seasonId: string | null;
  /** Heading for the group. */
  seasonName: string;
  /** True for the seasonless fallback set. */
  generic: boolean;
  /**
   * The season's designated chop — the one a label render resolves to. Null
   * for the generic group and for any season that hasn't nominated one.
   */
  primaryAssetId: string | null;
  chops: BrandAsset[];
}

/**
 * Groups approved chops by the season that claims them.
 *
 * The generic set leads: it is the fallback, and a fallback that appears after
 * the seasons reads as an afterthought rather than as the thing every season
 * falls back to. Seasons follow in the order given (the API orders them newest
 * first), and a season with no chops is omitted — an empty heading tells a
 * reader nothing they can act on.
 *
 * A chop pointing at a season that no longer exists lands in the generic group
 * rather than vanishing. The FK is ON DELETE SET NULL so the database normally
 * does this itself; this covers the window before it has.
 */
export function groupChopsBySeason(chops: BrandAsset[], seasons: BrandSeason[]): ChopGroup[] {
  const knownSeasons = new Set(seasons.map((s) => s.id));

  const generic = chops.filter((c) => !c.season_id || !knownSeasons.has(c.season_id));
  const groups: ChopGroup[] = [];

  if (generic.length > 0) {
    groups.push({
      seasonId: null,
      seasonName: "Generic",
      generic: true,
      primaryAssetId: null,
      chops: generic,
    });
  }

  for (const season of seasons) {
    const owned = chops.filter((c) => c.season_id === season.id);
    if (owned.length === 0) continue;
    groups.push({
      seasonId: season.id,
      seasonName: season.name,
      generic: false,
      primaryAssetId: season.chop_glyph_asset_id,
      chops: owned,
    });
  }

  return groups;
}
