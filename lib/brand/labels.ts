// Labels model each beer as a story: title/subtitle, motif family, an
// earned Tier-2 palette, a 5-criteria naming check, and an assigned chop
// glyph asset. Same injected-client testability pattern as
// canonWorkflow.ts / assets.ts: callers pass createSupabaseAdminClient() in
// production, a fake client in tests.

export interface Tier2Palette {
  colors: { name: string; hex: string; note?: string }[];
}

export interface NamingCheck {
  results: { criterion: string; pass: boolean; note?: string }[];
}

export interface BrandLabel {
  id: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  motif_family: string | null;
  status: "draft" | "approved" | "archived";
  tier2_palette: Tier2Palette;
  naming_check: NamingCheck;
  chop_glyph_asset_id: string | null;
}

interface QueryChain {
  eq(column: string, value: string): QueryChain;
  order(
    column: string,
    opts?: { ascending?: boolean },
  ): Promise<{ data: BrandLabel[] | null; error: unknown }>;
  limit(n: number): Promise<{ data: BrandLabel[] | null; error: unknown }>;
}

export interface SupabaseLikeClient {
  from(table: string): {
    select(columns: string): QueryChain;
    insert(row: Record<string, unknown>): {
      select(): {
        single(): Promise<{ data: BrandLabel | null; error: unknown }>;
      };
    };
    update(patch: Record<string, unknown>): {
      eq(column: string, value: string): Promise<{ error: unknown }>;
    };
  };
}

const TABLE = "brand_labels";

// Pure: builds the naming-check result set for the given criteria, preserving
// pass/note for criteria that still exist (matched by criterion text), adding
// new criteria as {criterion, pass:false}, and dropping stale ones. Output
// order matches `criteria`.
export function syncNamingCheck(criteria: string[], existing: NamingCheck): NamingCheck {
  const existingByCriterion = new Map(existing.results.map((r) => [r.criterion, r]));
  const results = criteria.map((criterion) => {
    const prev = existingByCriterion.get(criterion);
    return prev ? { ...prev, criterion } : { criterion, pass: false };
  });
  return { results };
}

export async function listLabels(
  client: SupabaseLikeClient,
  filter?: { status?: BrandLabel["status"] },
): Promise<BrandLabel[]> {
  const query = client.from(TABLE).select("*");
  const filtered = filter?.status ? query.eq("status", filter.status) : query;
  const { data } = await filtered.order("created_at", { ascending: false });
  return data ?? [];
}

export async function getLabel(client: SupabaseLikeClient, id: string): Promise<BrandLabel | null> {
  const { data } = await client.from(TABLE).select("*").eq("id", id).limit(1);
  return data && data.length > 0 ? data[0] : null;
}

export async function createLabel(
  client: SupabaseLikeClient,
  row: { name: string; subtitle?: string; description?: string; motif_family?: string },
): Promise<BrandLabel> {
  const { data, error } = await client
    .from(TABLE)
    .insert({
      name: row.name,
      subtitle: row.subtitle ?? null,
      description: row.description ?? null,
      motif_family: row.motif_family ?? null,
      status: "draft",
      tier2_palette: { colors: [] },
      naming_check: { results: [] },
      chop_glyph_asset_id: null,
    })
    .select()
    .single();
  if (error || !data) throw new Error("Failed to create label");
  return data;
}

export async function updateLabel(
  client: SupabaseLikeClient,
  id: string,
  patch: Partial<Omit<BrandLabel, "id">>,
): Promise<void> {
  const { error } = await client.from(TABLE).update(patch).eq("id", id);
  if (error) throw new Error("Failed to update label");
}

// Labels aren't singleton (unlike canon/assets' one-approved-per-key
// invariant) — multiple approved labels coexist, so this is a plain status
// flip with no archive-before-write dance.
export async function approveLabel(client: SupabaseLikeClient, id: string): Promise<void> {
  const { error } = await client
    .from(TABLE)
    .update({ status: "approved", approved_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error("Failed to approve label");
}

export async function archiveLabel(client: SupabaseLikeClient, id: string): Promise<void> {
  const { error } = await client.from(TABLE).update({ status: "archived" }).eq("id", id);
  if (error) throw new Error("Failed to archive label");
}

export async function resolveApprovedLabels(client: SupabaseLikeClient): Promise<BrandLabel[]> {
  return listLabels(client, { status: "approved" });
}
