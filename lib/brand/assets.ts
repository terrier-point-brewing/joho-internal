export type BrandAssetKind = "logo" | "wordmark" | "chop_glyph" | "texture" | "icon" | "photo";

export interface BrandAsset {
  id: string;
  kind: BrandAssetKind;
  variant: string;
  storage_path: string;
  format: string;
  file_meta: Record<string, unknown>;
  status: "draft" | "approved" | "archived";
}

// Same injected-client testability pattern as canonWorkflow.ts: callers pass
// createSupabaseAdminClient() in production, a fake client in tests. Uploading
// the binary lives in the API route via sb.storage — these functions operate
// on the brand_assets table only.
interface QueryChain {
  eq(column: string, value: string): QueryChain;
  order(
    column: string,
    opts?: { ascending?: boolean },
  ): Promise<{ data: BrandAsset[] | null; error: unknown }>;
  limit(n: number): Promise<{ data: BrandAsset[] | null; error: unknown }>;
}

export interface SupabaseLikeClient {
  from(table: string): {
    select(columns: string): QueryChain;
    insert(row: Record<string, unknown>): {
      select(): {
        single(): Promise<{ data: BrandAsset | null; error: unknown }>;
      };
    };
    update(patch: Record<string, unknown>): {
      eq(column: string, value: string): Promise<{ error: unknown }>;
    };
  };
}

const TABLE = "brand_assets";

// Pure: builds the public Storage URL for a path in the brand-assets bucket.
export function publicUrlFor(path: string): string {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/brand-assets/${path}`;
}

// Returns the approved row's public URL for the given kind+variant, or null
// if none is approved (draft/archived-only or no rows at all).
export async function resolveAsset(
  client: SupabaseLikeClient,
  { kind, variant = "default" }: { kind: BrandAssetKind; variant?: string },
): Promise<string | null> {
  const { data } = await client
    .from(TABLE)
    .select("storage_path")
    .eq("kind", kind)
    .eq("variant", variant)
    .eq("status", "approved")
    .limit(1);
  if (!data || data.length === 0) return null;
  return publicUrlFor(data[0].storage_path);
}

export async function listAssets(
  client: SupabaseLikeClient,
  filter?: { kind?: BrandAssetKind },
): Promise<BrandAsset[]> {
  const query = client.from(TABLE).select("*");
  const filtered = filter?.kind ? query.eq("kind", filter.kind) : query;
  const { data } = await filtered.order("created_at", { ascending: false });
  return data ?? [];
}

export async function createAsset(
  client: SupabaseLikeClient,
  row: {
    kind: BrandAssetKind;
    variant: string;
    storage_path: string;
    format: string;
    file_meta: Record<string, unknown>;
  },
): Promise<BrandAsset> {
  const { data, error } = await client
    .from(TABLE)
    .insert({ ...row, status: "draft" })
    .select()
    .single();
  if (error || !data) throw new Error("Failed to create asset");
  return data;
}

// Archives the prior approved row for the SAME (kind,variant) BEFORE
// approving the new one. Mirrors canonWorkflow.publishDraft's archive-before-
// write: the brand_assets_one_approved partial unique index forbids two
// approved rows per (kind,variant), so approve-then-archive would violate the
// index on every re-approve after the first.
export async function approveAsset(client: SupabaseLikeClient, id: string): Promise<void> {
  const { data: targetRows } = await client.from(TABLE).select("*").eq("id", id).limit(1);
  const target = targetRows?.[0];
  if (!target) throw new Error("Asset not found");

  const { data: approvedRows } = await client
    .from(TABLE)
    .select("*")
    .eq("kind", target.kind)
    .eq("variant", target.variant)
    .eq("status", "approved")
    .limit(1);
  const currentApproved = approvedRows?.[0];

  if (currentApproved && currentApproved.id !== target.id) {
    await client.from(TABLE).update({ status: "archived" }).eq("id", currentApproved.id);
  }

  const { error } = await client
    .from(TABLE)
    .update({ status: "approved", approved_at: new Date().toISOString() })
    .eq("id", target.id);
  if (error) throw new Error("Failed to approve asset");
}

export async function archiveAsset(client: SupabaseLikeClient, id: string): Promise<void> {
  await client.from(TABLE).update({ status: "archived" }).eq("id", id);
}
