/**
 * Brand seasons — the rotation a `motif` slot resolves against.
 *
 * The canon's chop spec is what defines the shape here: "Glyph only — script or
 * symbol per active motif family... The glyph rotates per motif family; position,
 * footprint, color and rendering never change." So a season carries the two
 * things that rotate — a ground color and a chop glyph — and nothing about
 * placement, which is fixed and lives in the canon.
 *
 * Same injected-client pattern as the other lib/brand modules.
 */

export interface BrandSeason {
  id: string;
  name: string;
  chop_glyph_asset_id: string | null;
  background_hex: string | null;
  cultural_lean: string | null;
  motif_set: { assetId: string; note?: string }[];
  season_logo_asset_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  status: "draft" | "active" | "archived";
}

interface QueryChain {
  eq(column: string, value: string): QueryChain;
  order(
    column: string,
    opts?: { ascending?: boolean },
  ): Promise<{ data: BrandSeason[] | null; error: unknown }>;
  limit(n: number): Promise<{ data: BrandSeason[] | null; error: unknown }>;
}

export interface SupabaseLikeClient {
  from(table: string): {
    select(columns: string): QueryChain;
    insert(row: Record<string, unknown>): {
      select(): { single(): Promise<{ data: BrandSeason | null; error: unknown }> };
    };
    update(patch: Record<string, unknown>): {
      eq(column: string, value: string): Promise<{ error: unknown }>;
    };
  };
}

const TABLE = "brand_seasons";

/**
 * The shape the slot validator consumes.
 *
 * Deliberately narrow: the validator should not be able to reach anything about
 * a season beyond what a motif slot can resolve, or it grows the ability to
 * apply season rules that were never declared as slots.
 */
export function seasonContext(season: BrandSeason | null) {
  if (!season) return null;
  return {
    backgroundHex: season.background_hex,
    chopGlyphAssetId: season.chop_glyph_asset_id,
    seasonLogoAssetId: season.season_logo_asset_id,
  };
}

export async function listSeasons(client: SupabaseLikeClient): Promise<BrandSeason[]> {
  const { data } = await client.from(TABLE).select("*").order("starts_at", { ascending: false });
  return data ?? [];
}

/** The one season in force, or null. Enforced single by a partial unique index. */
export async function getActiveSeason(client: SupabaseLikeClient): Promise<BrandSeason | null> {
  const { data } = await client.from(TABLE).select("*").eq("status", "active").limit(1);
  return data?.[0] ?? null;
}

export async function createSeason(
  client: SupabaseLikeClient,
  row: {
    name: string;
    background_hex?: string | null;
    chop_glyph_asset_id?: string | null;
    cultural_lean?: string | null;
    starts_at?: string | null;
    ends_at?: string | null;
  },
): Promise<BrandSeason> {
  const { data, error } = await client
    .from(TABLE)
    .insert({
      name: row.name,
      background_hex: row.background_hex ?? null,
      chop_glyph_asset_id: row.chop_glyph_asset_id ?? null,
      cultural_lean: row.cultural_lean ?? null,
      season_logo_asset_id: null,
      motif_set: [],
      starts_at: row.starts_at ?? null,
      ends_at: row.ends_at ?? null,
      status: "draft",
    })
    .select()
    .single();
  if (error || !data) throw new Error("Failed to create season");
  return data;
}

export async function updateSeason(
  client: SupabaseLikeClient,
  id: string,
  patch: Partial<Omit<BrandSeason, "id">>,
): Promise<void> {
  const { error } = await client.from(TABLE).update(patch).eq("id", id);
  if (error) throw new Error("Failed to update season");
}

/**
 * Make a season the active one, archiving whichever season it replaces.
 *
 * Archive-before-write for the same reason as templates and assets: the
 * brand_seasons_one_active partial unique index forbids two active rows, so
 * activate-then-archive would violate it on every rotation after the first.
 *
 * This is the moment every `motif` slot in the system changes what it resolves
 * to, which is why it is one deliberate action rather than a status dropdown.
 */
export async function activateSeason(client: SupabaseLikeClient, id: string): Promise<void> {
  const { data: targets } = await client.from(TABLE).select("*").eq("id", id).limit(1);
  const target = targets?.[0];
  if (!target) throw new Error("Season not found");

  const { data: live } = await client.from(TABLE).select("*").eq("status", "active").limit(1);
  const current = live?.[0];

  if (current && current.id !== target.id) {
    await client.from(TABLE).update({ status: "archived" }).eq("id", current.id);
  }

  const { error } = await client.from(TABLE).update({ status: "active" }).eq("id", target.id);
  if (error) throw new Error("Failed to activate season");
}
