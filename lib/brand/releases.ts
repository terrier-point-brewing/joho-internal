// Brand releases — the spine of the release workflow (migration
// 20260922110000). One row per release: identity (name, season + episode),
// the release-card copy (story line, menu description, naming check), and the
// link to the Production recipe it pours. Components that are workflows hang
// off this row in their own tables (today: brand_labels via release_id).
//
// Same injected-client pattern as the other lib/brand modules: callers pass
// createSupabaseAdminClient() in production, a fake client in tests.

import type { NamingCheck } from "./labels";

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

// ── Pure component rollups ───────────────────────────────────────────────────
// The frame's card chips. Each component declares its own "done"; the frame
// only aggregates. Adding a future component (apparel, merch, marketing) means
// adding a status function like these next to its own table — nothing here
// changes shape.

/** Beer Recipe card: done once a Production recipe is linked. */
export function recipeComponentStatus(release: Pick<BrandRelease, "recipe_id">): ComponentStatus {
  return release.recipe_id ? "done" : "not_started";
}

/**
 * Release Card card: done when the card reads like the guide's template —
 * name, story line, menu description, a place in a season (S# | E#) — and
 * every naming criterion passes. criteria is the published canon's list, so
 * a check that predates a new criterion correctly drops back to in-progress.
 */
export function cardComponentStatus(
  release: Pick<
    BrandRelease,
    "name" | "story_line" | "menu_description" | "season_id" | "episode" | "naming_check"
  >,
  criteria: string[],
): ComponentStatus {
  const passByCriterion = new Map(
    (release.naming_check?.results ?? []).map((r) => [r.criterion, r.pass]),
  );
  const namingDone = criteria.length > 0 && criteria.every((c) => passByCriterion.get(c) === true);
  const fieldsDone = Boolean(
    release.name && release.story_line && release.menu_description && release.season_id && release.episode,
  );
  if (fieldsDone && namingDone) return "done";
  const touched = Boolean(
    release.story_line ||
      release.menu_description ||
      release.season_id ||
      release.episode ||
      (release.naming_check?.results ?? []).some((r) => r.pass || r.note),
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
