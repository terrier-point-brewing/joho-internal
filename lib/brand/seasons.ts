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

/**
 * Palette ROLES a season may inflect, and no more.
 *
 * `ground` is deliberately absent: the season ground is the one colour a season
 * genuinely owns, and it already lives in `background_hex` with its own hex
 * CHECK. Giving it a role here would give one fact two homes. This list mirrors
 * the `brand_seasons_palette_shape` CHECK exactly — the two are changed together.
 */
export const SEASON_PALETTE_ROLES = ["ink", "accent"] as const;
export type SeasonPaletteRole = (typeof SEASON_PALETTE_ROLES)[number];

/** role → canon token KEY. Never a hex — see normalizeSeasonPalette. */
export type SeasonPalette = Partial<Record<SeasonPaletteRole, string>>;

/** The three jobs an asset can hold inside a season's kit. */
export const SEASON_ASSET_ROLES = ["motif", "example", "texture"] as const;
export type SeasonAssetRole = (typeof SEASON_ASSET_ROLES)[number];

/**
 * A membership row in `brand_season_assets`.
 *
 * `role` is part of the key: one file can legitimately be both a texture and a
 * motif in the same season.
 */
export interface BrandSeasonAsset {
  season_id: string;
  asset_id: string;
  role: SeasonAssetRole;
  position: number;
  note: string | null;
}

export interface BrandSeason {
  id: string;
  name: string;
  chop_glyph_asset_id: string | null;
  background_hex: string | null;
  cultural_lean: string | null;
  /**
   * LEGACY from the season-kit board onward. `brand_season_assets` is where a
   * season's motifs live; migration 20261029090000 copied this column's
   * contents into rows and nothing writes it any more. Left on the type because
   * the column is still selected by `select("*")`.
   */
  motif_set: { assetId: string; note?: string }[];
  season_logo_asset_id: string | null;
  /** Role → canon token key. `{}` on every row until someone fills one in. */
  palette: SeasonPalette;
  /** One or two sentences on how this season sounds. An inflection, not a voice. */
  voice_note: string | null;
  starts_at: string | null;
  ends_at: string | null;
  status: "draft" | "active" | "archived";
  /**
   * Why this season was put into force with an incomplete kit, or null if it
   * was not — which covers both "never overridden" and "activated clean".
   *
   * Written only by `activateSeason`, and cleared by it on a complete
   * activation, so the value always describes the activation currently in
   * effect. Never set by a migration: "Season 1" predates the gate and is
   * grandfathered, not overridden.
   */
  activation_override_reason: string | null;
}

/** A season plus its asset rows — what the board renders from. */
export interface SeasonKit extends BrandSeason {
  kit: BrandSeasonAsset[];
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

/**
 * The query shapes `brand_season_assets` needs, which `SupabaseLikeClient`'s do
 * not cover: the table has a composite primary key and no `id`, so every write
 * addresses a row by three columns at once via `.match()`.
 *
 * A separate interface rather than a union on `from()` because the two tables
 * are reached through separate casts of the same admin client, exactly as the
 * routes already cast it once today.
 */
export interface SeasonAssetSelect {
  eq(column: string, value: string): SeasonAssetSelect;
  order(
    column: string,
    opts?: { ascending?: boolean },
  ): Promise<{ data: BrandSeasonAsset[] | null; error: unknown }>;
}

export interface SeasonAssetMatch {
  match(criteria: Record<string, string>): Promise<{ error: unknown }>;
}

export interface SeasonAssetClient {
  from(table: string): {
    select(columns: string): SeasonAssetSelect;
    insert(row: Record<string, unknown>): Promise<{ error: unknown }>;
    update(patch: Record<string, unknown>): SeasonAssetMatch;
    delete(): SeasonAssetMatch;
  };
}

const TABLE = "brand_seasons";
const ASSET_TABLE = "brand_season_assets";

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
      // `motif_set` is deliberately not written. It is legacy from the season-kit
      // board onward — motifs are rows in `brand_season_assets` — and the column
      // defaults to '[]' on its own, so naming it here would be the only write to
      // it left in the codebase.
      starts_at: row.starts_at ?? null,
      ends_at: row.ends_at ?? null,
      status: "draft",
    })
    .select()
    .single();
  if (error || !data) throw new Error("Failed to create season");
  return data;
}

/**
 * Field edits only.
 *
 * Two columns are deliberately not patchable, and both are stripped HERE rather
 * than in the route, because the route forwards an arbitrary body and a second
 * field-patch route added later would bypass a check that lived up there
 * (`project_field_patch_routes_bypass_gated_actions`):
 *
 * - `status`, because activation archives the outgoing season and is gated on
 *   kitGaps(), so a patch that could set status:"active" would be a way round
 *   the gate.
 * - `activation_override_reason`, because it is the RECORD of an activation,
 *   not a field about the season. Letting it be edited on its own would allow
 *   both halves of the lie: a season claiming an override it never took, and an
 *   overridden season quietly erasing why.
 */
export async function updateSeason(
  client: SupabaseLikeClient,
  id: string,
  patch: Partial<Omit<BrandSeason, "id" | "status" | "activation_override_reason">>,
): Promise<void> {
  const fields = { ...(patch as Partial<BrandSeason>) };
  delete fields.status;
  delete fields.activation_override_reason;
  const { error } = await client.from(TABLE).update(fields).eq("id", id);
  if (error) throw new Error("Failed to update season");
}

/**
 * What a `motif` slot cannot resolve against this season.
 *
 * NOT the activation gate — that is `kitGaps`, and there is exactly one of it.
 * This answers a narrower, different question: given this season, which motif
 * slots would fail validation right now? A `motif: chop-glyph` slot has nowhere
 * to fall back to, because the canon fixes the chop's position, footprint and
 * colour and leaves only the glyph to the season. A `motif: background` slot is
 * the same kind of failure, but plenty of templates (menu, apparel) simply do
 * not declare one, so it degrades rather than breaks everything.
 *
 * It exists for the season editor's hint, which is worth saying about the
 * season ALREADY in force: "Season 1" is active with no glyph, so every chop
 * slot in the system fails against it today, and only this sentence says so.
 * Its lists are a subset of `kitGaps`, never a second opinion about it.
 */
export function motifResolutionGaps(
  season: Pick<BrandSeason, "chop_glyph_asset_id" | "background_hex">,
): { unresolvable: string[]; degraded: string[] } {
  // Phrased as noun phrases that read after "needs …" and after "no … set".
  return {
    unresolvable: season.chop_glyph_asset_id ? [] : ["a chop glyph"],
    degraded: season.background_hex ? [] : ["background color"],
  };
}

/**
 * Make a season the active one, archiving whichever season it replaces.
 *
 * Archive-before-write for the same reason as templates and assets: the
 * brand_seasons_one_active partial unique index forbids two active rows, so
 * activate-then-archive would violate it on every rotation after the first.
 *
 * This is the moment every `motif` slot in the system changes what it resolves
 * to, which is why it is one deliberate action rather than a status dropdown —
 * and why it is gated the way publishTemplate is gated on validateTemplateShape.
 *
 * THE GATE IS `kitGaps`, the same function the board's "not furnished yet"
 * sentence is drawn from. Completeness asked at activation time and
 * completeness asked while looking at the board are the same question at two
 * moments; a second copy of the rule would drift, and the drift would be
 * invisible until someone activated a season they should not have.
 *
 * The kit rows come from a second client because `brand_season_assets` has a
 * composite key and no `id` — the same two casts of one admin client the routes
 * already make.
 */
export async function activateSeason(
  client: SupabaseLikeClient,
  assetClient: SeasonAssetClient,
  id: string,
  options: { overrideReason?: string | null } = {},
): Promise<void> {
  const { data: targets } = await client.from(TABLE).select("*").eq("id", id).limit(1);
  const target = targets?.[0];
  if (!target) throw new Error("Season not found");

  const gaps = kitGaps(target, await listSeasonAssets(assetClient, id));
  // Blank is not a reason. NO REASON, NO OVERRIDE — the column's CHECK says the
  // same thing, so a caller that skips this cannot get a blank one in either.
  const reason = options.overrideReason?.trim() || null;

  // Checked before the outgoing season is archived, so a refused activation
  // leaves the rotation exactly as it was.
  if (gaps.length > 0 && !reason) {
    throw new Error(activationRefusal(target.name, gaps) as string);
  }

  const { data: live } = await client.from(TABLE).select("*").eq("status", "active").limit(1);
  const current = live?.[0];

  if (current && current.id !== target.id) {
    await client.from(TABLE).update({ status: "archived" }).eq("id", current.id);
  }

  const { error } = await client
    .from(TABLE)
    .update({
      status: "active",
      // A complete season is not an override, whatever the caller sent — and a
      // stale reason left behind by an earlier one would have the board claim
      // a season went out unfinished when it did not.
      activation_override_reason: gaps.length > 0 ? reason : null,
    })
    .eq("id", target.id);
  if (error) throw new Error("Failed to activate season");
}

/**
 * Why an activation was refused, in one sentence a person can act on.
 *
 * Names every missing piece rather than the first — a refusal you have to earn
 * one field at a time teaches nothing about what finished looks like, which is
 * the whole reason this gate exists. Null when there is nothing to refuse.
 */
export function activationRefusal(name: string, gaps: string[]): string | null {
  if (gaps.length === 0) return null;
  return `${name} cannot go into force yet — it still needs ${joinPhrases(gaps)}. Put it in force unfinished only with a reason, which goes on the record.`;
}

/**
 * Start a new season from an existing one.
 *
 * Half of a season is continuity, and re-picking it by hand every quarter is
 * how a brand drifts. So the clone CARRIES what continues — the palette roles,
 * the voice note, the cultural lean, the examples — and CLEARS what actually
 * rotates: the ground, the chop glyph, the season logo, the motifs and the
 * dates. That split is the whole point of the feature.
 *
 * Textures carry. The spec enumerates motifs as rotating and examples as
 * continuity and does not name textures either way; a texture is a material
 * substrate rather than a seasonal vocabulary, so it sits on the continuity
 * side. It is one click to remove if a season disagrees.
 *
 * A clone is NEVER active on creation, whatever it was cloned from, and never
 * carries an override reason: it has not been activated, so there is nothing to
 * record about how it was.
 */
export async function cloneSeason(
  client: SupabaseLikeClient,
  assetClient: SeasonAssetClient,
  sourceId: string,
  name: string,
): Promise<BrandSeason> {
  const { data: found } = await client.from(TABLE).select("*").eq("id", sourceId).limit(1);
  const source = found?.[0];
  if (!source) throw new Error("There is no season to start from.");

  const { data, error } = await client
    .from(TABLE)
    .insert({
      name,
      // Carried — continuity.
      palette: source.palette ?? {},
      voice_note: source.voice_note ?? null,
      cultural_lean: source.cultural_lean ?? null,
      // Cleared — what rotates.
      background_hex: null,
      chop_glyph_asset_id: null,
      season_logo_asset_id: null,
      starts_at: null,
      ends_at: null,
      status: "draft",
      activation_override_reason: null,
    })
    .select()
    .single();
  if (error || !data) throw new Error("Failed to clone season");

  // In position order, so the carried rows land in the order they were left in.
  // `addSeasonAsset` re-derives each position rather than copying it: the source
  // may have gaps in its numbering, and a dense 0..n is what a reorder expects.
  for (const row of await listSeasonAssets(assetClient, sourceId)) {
    if (row.role === "motif") continue;
    await addSeasonAsset(assetClient, {
      season_id: data.id,
      asset_id: row.asset_id,
      role: row.role,
      note: row.note,
    });
  }

  return data;
}

// ─── The palette: roles that select from the canon, never redefine it ────────

/**
 * One colour the canon declares, as the palette picker offers it.
 *
 * Structurally typed rather than importing `BrandCanon` so this module keeps its
 * zero-dependency shape and the choices can be handed to a client component as a
 * plain serializable prop.
 */
export interface CanonToken {
  key: string;
  name: string;
  hex: string;
  tier?: string | null;
}

/**
 * The vocabulary a season may choose from: the canon's palette keys.
 *
 * The canon's THEME roles (`on-primary`, `line-strong`, …) are deliberately not
 * offered. Those are bindings from the app's surfaces to a colour — they name
 * where a colour is used, not which colour the brand owns — and a season picks a
 * brand colour. Nothing has ever written a theme role into `palette`, so nothing
 * is being taken away; a stored one would resolve as "unknown", which is the
 * honest answer for a key the picker cannot produce.
 *
 * Core colours first, then neutrals, matching the Brand Guide's Color tab.
 */
export function canonTokenChoices(canon: { palette: CanonToken[] }): CanonToken[] {
  const core = canon.palette.filter((c) => c.tier === "core");
  const rest = canon.palette.filter((c) => c.tier !== "core");
  return [...core, ...rest].map((c) => ({ key: c.key, name: c.name, hex: c.hex, tier: c.tier ?? null }));
}

/**
 * What a stored palette role resolves to right now.
 *
 * `unknown` is the case that matters: a season stores a KEY, so a canon edit that
 * renames or drops a colour leaves the season pointing at nothing. Rendering
 * nothing would hide it; the board says so instead.
 */
export type ResolvedPaletteRole =
  | { role: SeasonPaletteRole; state: "unset" }
  | { role: SeasonPaletteRole; state: "resolved"; token: string; name: string; hex: string }
  | { role: SeasonPaletteRole; state: "unknown"; token: string };

export function resolveSeasonPalette(
  palette: SeasonPalette | null | undefined,
  tokens: CanonToken[],
): ResolvedPaletteRole[] {
  const byKey = new Map(tokens.map((t) => [t.key, t]));
  return SEASON_PALETTE_ROLES.map((role): ResolvedPaletteRole => {
    const token = palette?.[role];
    if (!token) return { role, state: "unset" };
    const found = byKey.get(token);
    return found
      ? { role, state: "resolved", token, name: found.name, hex: found.hex }
      : { role, state: "unknown", token };
  });
}

/**
 * Validates a palette patch against the LIVE canon before it is stored.
 *
 * The SQL CHECK constrains the shape — an object, two legal keys, lowercase
 * slugs — and deliberately not the vocabulary, because which token keys are
 * legal is whatever the canon currently declares. This is the other half: it is
 * what makes "a season selects and never redefines" true rather than aspirational,
 * and it is why the editor's picker is a list and not a text field.
 *
 * Throws a message worth showing a person — the routes surface a non-"Failed…"
 * error as a 400.
 */
export function normalizeSeasonPalette(input: unknown, tokens: CanonToken[]): SeasonPalette {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("palette must be an object of role → canon color key.");
  }

  const known = new Set(tokens.map((t) => t.key));
  const out: SeasonPalette = {};

  for (const [role, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(SEASON_PALETTE_ROLES as readonly string[]).includes(role)) {
      throw new Error(
        `"${role}" is not a season palette role. A season inflects ${SEASON_PALETTE_ROLES.join(" and ")}; the ground is its own field.`,
      );
    }
    // Clearing a role is absent, not an empty string — same convention as the
    // season's other nullable fields.
    if (value === null || value === "") continue;
    if (typeof value !== "string" || !known.has(value)) {
      throw new Error(
        `Palette role "${role}" must name a color the canon declares. "${String(value)}" is not one — if that color should exist, change the canon.`,
      );
    }
    out[role as SeasonPaletteRole] = value;
  }

  return out;
}

// ─── The kit: what a season still owes, and the rows that furnish it ─────────

/** Kit rows for one role, in display order. */
export function kitByRole(
  kit: BrandSeasonAsset[],
  role: SeasonAssetRole,
): BrandSeasonAsset[] {
  return kit.filter((k) => k.role === role).sort((a, b) => a.position - b.position);
}

/**
 * What a season is still missing before it counts as furnished.
 *
 * The list the spec names: a ground, a chop glyph, at least one motif, at least
 * one example, a voice note.
 *
 * THE ONE HOME OF THE COMPLETENESS RULE. The board's "not furnished yet"
 * sentence, the editor's hint, the "Make active" button and `activateSeason`'s
 * refusal all call this and none of them re-implements it. They are the same
 * question — is this kit finished? — asked at different moments, and a second
 * copy would drift silently until the day someone activated a season they
 * should not have. If completeness ever needs to change, it changes here.
 *
 * Phrased as noun phrases that read after "still needs …".
 */
export function kitGaps(
  season: Pick<BrandSeason, "background_hex" | "chop_glyph_asset_id" | "voice_note">,
  kit: Pick<BrandSeasonAsset, "role">[],
): string[] {
  const gaps: string[] = [];
  if (!season.background_hex) gaps.push("a ground color");
  if (!season.chop_glyph_asset_id) gaps.push("a chop glyph");
  if (!kit.some((k) => k.role === "motif")) gaps.push("a motif");
  if (!kit.some((k) => k.role === "example")) gaps.push("an example");
  if (!season.voice_note?.trim()) gaps.push("a voice note");
  return gaps;
}

/** "a, b and c" — the serial join both gap sentences use. */
export function joinPhrases(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The sentence an unfurnished kit says about itself, or null when it is complete.
 * One sentence, naming every missing piece — a kit that is short should not be
 * able to look finished.
 */
export function kitGapSentence(name: string, gaps: string[]): string | null {
  if (gaps.length === 0) return null;
  return `${name} is not furnished yet — it still needs ${joinPhrases(gaps)}.`;
}

/**
 * Dense renumbering after a one-step move.
 *
 * Renumbers the whole role group 0..n-1 rather than swapping two positions:
 * `position` carries no unique constraint (deliberately, so a reorder can pass
 * through a duplicate), and a group that has picked up duplicates would swap
 * into an order nobody asked for. Returns only the rows whose position actually
 * changes, so a move at the end of the list writes nothing.
 */
export function reorderKit(
  group: BrandSeasonAsset[],
  assetId: string,
  direction: "up" | "down",
): { asset_id: string; position: number }[] {
  const ordered = [...group].sort((a, b) => a.position - b.position);
  const from = ordered.findIndex((r) => r.asset_id === assetId);
  if (from === -1) return [];

  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= ordered.length) return [];

  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);

  return ordered
    .map((row, position) => ({ asset_id: row.asset_id, position }))
    .filter((next, i) => ordered[i].position !== next.position);
}

/** Every kit row, or one season's, ordered by position. */
export async function listSeasonAssets(
  client: SeasonAssetClient,
  seasonId?: string,
): Promise<BrandSeasonAsset[]> {
  const query = client.from(ASSET_TABLE).select("*");
  const filtered = seasonId ? query.eq("season_id", seasonId) : query;
  const { data } = await filtered.order("position", { ascending: true });
  return data ?? [];
}

/** seasonId → its kit rows. The board's read: one query for every panel. */
export async function listSeasonKits(
  client: SeasonAssetClient,
): Promise<Map<string, BrandSeasonAsset[]>> {
  const rows = await listSeasonAssets(client);
  const out = new Map<string, BrandSeasonAsset[]>();
  for (const row of rows) {
    const list = out.get(row.season_id);
    if (list) list.push(row);
    else out.set(row.season_id, [row]);
  }
  return out;
}

export interface SeasonAssetKey {
  season_id: string;
  asset_id: string;
  role: SeasonAssetRole;
}

/** Appends an asset to the end of its role group. */
export async function addSeasonAsset(
  client: SeasonAssetClient,
  entry: SeasonAssetKey & { note?: string | null },
): Promise<void> {
  const existing = await listSeasonAssets(client, entry.season_id);
  const group = kitByRole(existing, entry.role);
  const position = group.length === 0 ? 0 : Math.max(...group.map((g) => g.position)) + 1;

  const { error } = await client.from(ASSET_TABLE).insert({
    season_id: entry.season_id,
    asset_id: entry.asset_id,
    role: entry.role,
    position,
    note: entry.note?.trim() || null,
  });
  // The primary key is what refuses a duplicate; say so in words rather than
  // letting a constraint name reach the browser.
  if (error) throw new Error("That asset already holds that role in this season.");
}

export async function removeSeasonAsset(
  client: SeasonAssetClient,
  key: SeasonAssetKey,
): Promise<void> {
  const { error } = await client.from(ASSET_TABLE).delete().match({ ...key });
  if (error) throw new Error("Failed to remove the asset from this season");
}

export async function setSeasonAssetNote(
  client: SeasonAssetClient,
  key: SeasonAssetKey,
  note: string | null,
): Promise<void> {
  const { error } = await client
    .from(ASSET_TABLE)
    .update({ note: note?.trim() || null })
    .match({ ...key });
  if (error) throw new Error("Failed to save the note");
}

export async function moveSeasonAsset(
  client: SeasonAssetClient,
  key: SeasonAssetKey,
  direction: "up" | "down",
): Promise<void> {
  const group = kitByRole(await listSeasonAssets(client, key.season_id), key.role);
  for (const next of reorderKit(group, key.asset_id, direction)) {
    const { error } = await client
      .from(ASSET_TABLE)
      .update({ position: next.position })
      .match({ season_id: key.season_id, asset_id: next.asset_id, role: key.role });
    if (error) throw new Error("Failed to reorder the season's assets");
  }
}

/**
 * Moves one row to a different role, keeping its note.
 *
 * Two writes rather than one, because `role` is in the primary key. Insert
 * first, then delete: if the asset already holds the target role the insert
 * fails and the original row is still there, which is the safer of the two
 * failures.
 */
export async function setSeasonAssetRole(
  client: SeasonAssetClient,
  key: SeasonAssetKey,
  toRole: SeasonAssetRole,
): Promise<void> {
  if (toRole === key.role) return;

  const existing = await listSeasonAssets(client, key.season_id);
  const current = existing.find((r) => r.asset_id === key.asset_id && r.role === key.role);
  if (!current) throw new Error("That asset is not in this season's kit.");

  await addSeasonAsset(client, {
    season_id: key.season_id,
    asset_id: key.asset_id,
    role: toRole,
    note: current.note,
  });
  await removeSeasonAsset(client, key);
}
