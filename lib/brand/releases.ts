// Brand releases — the spine of the release workflow (migration
// 20260922110000). One row per release: identity (name, season + episode),
// the release-card copy (story line, menu description, naming check), and the
// link to the Production recipe it pours. Components that are workflows hang
// off this row in their own tables (today: brand_labels via release_id).
//
// Same injected-client pattern as the other lib/brand modules: callers pass
// createSupabaseAdminClient() in production, a fake client in tests.

import { labelComponentStatus, type BrandLabel, type NamingCheck } from "./labels";

export interface BrandRelease {
  id: string;
  name: string;
  story_line: string | null;
  menu_description: string | null;
  naming_check: NamingCheck;
  season_id: string | null;
  episode: number | null;
  recipe_id: string | null;
  status: "draft" | "released" | "archived";
  created_at: string;
  released_at: string | null;
}

export type ComponentStatus = "not_started" | "in_progress" | "done";

/**
 * The facts about the liquid that make a release sellable. Owned by Production
 * → Recipes; read here, never written.
 */
export interface RecipeFacts {
  style: string | null;
  abv: number | null;
}

/**
 * One of the linked recipe's sellable containers. Structurally a subset of
 * Production's `RecipePackagingVariation` so callers can pass those rows
 * straight in — lib/brand stays free of app imports.
 */
export interface ReleaseContainer {
  product_code: string | null;
  packaging_variations?: { container?: { type: string | null } | null } | null;
}

// ── Pure component rollups ───────────────────────────────────────────────────
// The frame's card chips. Each component declares its own "done"; the frame
// only aggregates. Adding a future component (apparel, merch, marketing) means
// adding a status function like these next to its own table — nothing here
// changes shape.

/**
 * What Production still owes a linked recipe before this release could pour.
 * One list, in the order a brewer would fill it in, so the card summary and
 * the publish gate can never name different gaps.
 */
export function recipeGaps(
  recipe: RecipeFacts | null | undefined,
  containers: ReleaseContainer[],
): string[] {
  const gaps: string[] = [];
  if (!recipe?.style) gaps.push("beer style");
  if (recipe?.abv == null) gaps.push("ABV");
  if (!containers.some((c) => c.packaging_variations?.container?.type === "can")) {
    gaps.push("a can variation");
  }
  return gaps;
}

/**
 * Beer Recipe card: linking a recipe STARTS this card, it doesn't finish it.
 * Ready means the liquid is genuinely specifiable and sellable — Production
 * knows its style and its ABV, and there is at least one can to pour it into.
 * A bare link used to read as "Ready", which made the whole rollup untrustworthy
 * as a publish gate: a release could go live pointing at a recipe with no ABV
 * and nothing to sell it in.
 */
export function recipeComponentStatus(
  release: Pick<BrandRelease, "recipe_id">,
  recipe: RecipeFacts | null | undefined,
  containers: ReleaseContainer[],
): ComponentStatus {
  if (!release.recipe_id) return "not_started";
  return recipeGaps(recipe, containers).length === 0 ? "done" : "in_progress";
}

/**
 * Release Card card: done when the card reads like the guide's template —
 * name, story line, menu description, a place in a season (S# | E#).
 *
 * The naming criteria are NOT a gate here. They were, as a five-checkbox form
 * on the card, and nobody filled it in — which left the card permanently
 * in-progress. The gates are a writer's test, not a data field, so they now
 * render as the guide's own text beside the fields (see lib/brand/releaseGuide.ts).
 * `naming_check` stays on the row, unread and unwritten, with the data it
 * already holds — same posture as the legacy label columns.
 */
export function cardComponentStatus(
  release: Pick<
    BrandRelease,
    "name" | "story_line" | "menu_description" | "season_id" | "episode"
  >,
): ComponentStatus {
  const fieldsDone = Boolean(
    release.name && release.story_line && release.menu_description && release.season_id && release.episode,
  );
  if (fieldsDone) return "done";
  const touched = Boolean(
    release.story_line || release.menu_description || release.season_id || release.episode,
  );
  return touched ? "in_progress" : "not_started";
}

/**
 * Product Codes card: done when every sellable container of the linked recipe
 * carries a code. Codes can only exist after the packaging variations do —
 * which in turn are defined after the release card is written — so with no
 * recipe or no variations yet the card simply hasn't started.
 */
export function codesComponentStatus(
  recipeLinked: boolean,
  containers: { product_code: string | null }[],
): ComponentStatus {
  if (!recipeLinked || containers.length === 0) return "not_started";
  const coded = containers.filter((c) => c.product_code).length;
  if (coded === containers.length) return "done";
  return coded > 0 ? "in_progress" : "not_started";
}

// ── Readiness ────────────────────────────────────────────────────────────────
// Publishing a release is gated on every component being ready. The rollup
// lives here, not in the workbench, because two callers have to agree on it:
// the button that disables itself and the API route that refuses the flip. A
// stale tab or a direct PATCH must not be able to publish a half-built release.

/** The components that make up a release, and what the frame calls each one. */
export const RELEASE_COMPONENT_TITLES = {
  recipe: "Beer Recipe",
  card: "Release Card",
  codes: "Product Codes",
  label: "Label",
} as const;

export type ReleaseComponentKey = keyof typeof RELEASE_COMPONENT_TITLES;

/** Everything the four status functions need, gathered from four tables. */
export interface ReleaseReadinessInput {
  release: BrandRelease;
  recipe: RecipeFacts | null;
  containers: ReleaseContainer[];
  label: BrandLabel | null;
}

export function releaseComponentStatuses(
  input: ReleaseReadinessInput,
): Record<ReleaseComponentKey, ComponentStatus> {
  const { release, recipe, containers, label } = input;
  return {
    recipe: recipeComponentStatus(release, recipe, containers),
    card: cardComponentStatus(release),
    codes: codesComponentStatus(Boolean(release.recipe_id), containers),
    label: labelComponentStatus(label),
  };
}

/** `outstanding` is the titles of the components that aren't ready, in card order. */
export function releaseReadiness(input: ReleaseReadinessInput): {
  ready: boolean;
  outstanding: string[];
} {
  const statuses = releaseComponentStatuses(input);
  const outstanding = (Object.keys(RELEASE_COMPONENT_TITLES) as ReleaseComponentKey[])
    .filter((key) => statuses[key] !== "done")
    .map((key) => RELEASE_COMPONENT_TITLES[key]);
  return { ready: outstanding.length === 0, outstanding };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

interface QueryChain {
  eq(column: string, value: string): QueryChain;
  order(
    column: string,
    opts?: { ascending?: boolean },
  ): Promise<{ data: BrandRelease[] | null; error: unknown }>;
  limit(n: number): Promise<{ data: BrandRelease[] | null; error: unknown }>;
}

export interface SupabaseLikeClient {
  from(table: string): {
    select(columns: string): QueryChain;
    insert(row: Record<string, unknown>): {
      select(): {
        single(): Promise<{ data: BrandRelease | null; error: unknown }>;
      };
    };
    update(patch: Record<string, unknown>): {
      eq(column: string, value: string): Promise<{ error: unknown }>;
    };
  };
}

const TABLE = "brand_releases";

export async function listReleases(
  client: SupabaseLikeClient,
  filter?: { status?: BrandRelease["status"] },
): Promise<BrandRelease[]> {
  const query = client.from(TABLE).select("*");
  const filtered = filter?.status ? query.eq("status", filter.status) : query;
  const { data } = await filtered.order("created_at", { ascending: false });
  return data ?? [];
}

export async function getRelease(
  client: SupabaseLikeClient,
  id: string,
): Promise<BrandRelease | null> {
  const { data } = await client.from(TABLE).select("*").eq("id", id).limit(1);
  return data && data.length > 0 ? data[0] : null;
}

export async function createRelease(
  client: SupabaseLikeClient,
  row: { name: string },
): Promise<BrandRelease> {
  const { data, error } = await client
    .from(TABLE)
    .insert({
      name: row.name,
      story_line: null,
      menu_description: null,
      naming_check: { results: [] },
      season_id: null,
      episode: null,
      recipe_id: null,
      status: "draft",
    })
    .select()
    .single();
  if (error || !data) throw new Error("Failed to create release");
  return data;
}

export async function updateRelease(
  client: SupabaseLikeClient,
  id: string,
  patch: Partial<Omit<BrandRelease, "id">>,
): Promise<void> {
  const { error } = await client.from(TABLE).update(patch).eq("id", id);
  if (error) throw new Error("Failed to update release");
}

// Like labels, releases are not singleton — many released rows coexist, so
// these are plain status flips.
//
// The wire value stays `released` (the table's check constraint owns it); the
// UI calls this state "Published". Don't "fix" one to match the other without
// a migration.
//
// No readiness check here: this writes one row, and the gate needs four tables.
// Callers run `releaseReadiness` first — see app/api/brand/releases/[id]/route.ts.
export async function markReleased(client: SupabaseLikeClient, id: string): Promise<void> {
  const { error } = await client
    .from(TABLE)
    .update({ status: "released", released_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error("Failed to mark release as released");
}

export async function archiveRelease(client: SupabaseLikeClient, id: string): Promise<void> {
  const { error } = await client.from(TABLE).update({ status: "archived" }).eq("id", id);
  if (error) throw new Error("Failed to archive release");
}
