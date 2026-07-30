// Single source of truth for the asset kinds — mirrors the brand_assets.kind
// check constraint (migrations 20260810, 20260903). The API validates uploads
// against this, so the two must be changed together.
//
//   font    — uploaded typefaces, emitted as @font-face for the Type tab
//   example — do/don't imagery for Visual Identity and forbidden colors
export const BRAND_ASSET_KINDS = [
  "logo",
  "wordmark",
  "chop_glyph",
  "texture",
  "icon",
  "photo",
  "font",
  "example",
] as const;
export type BrandAssetKind = (typeof BRAND_ASSET_KINDS)[number];

export interface BrandAsset {
  id: string;
  kind: BrandAssetKind;
  variant: string;
  storage_path: string;
  format: string;
  file_meta: Record<string, unknown>;
  status: "draft" | "approved" | "archived";
  /** Human label for the library; null on rows predating migration 20260903. */
  title?: string | null;
  /** Required for accessible do/don't imagery. Null on older rows. */
  alt_text?: string | null;
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

/**
 * Pure: the URL an asset's bytes are served from.
 *
 * The `brand-assets` bucket is PRIVATE (migration 20260903), so there is no
 * public storage URL to build. Bytes come through a session-gated proxy route
 * instead — `app/api/brand/assets/[id]/file`.
 *
 * A permanent, origin-relative path rather than a signed URL, deliberately:
 * signed URLs expire, which breaks an `@font-face src` that must outlive a
 * cached page, an `<img src>` inside a cached RSC payload, and a stable
 * download link on a mark's spec sheet.
 */
export function assetFileUrl(id: string): string {
  return `/api/brand/assets/${id}/file`;
}

// Returns the approved row's URL for the given kind+variant, or null if none is
// approved (draft/archived-only or no rows at all).
export async function resolveAsset(
  client: SupabaseLikeClient,
  { kind, variant = "default" }: { kind: BrandAssetKind; variant?: string },
): Promise<string | null> {
  const { data } = await client
    .from(TABLE)
    .select("id")
    .eq("kind", kind)
    .eq("variant", variant)
    .eq("status", "approved")
    .limit(1);
  if (!data || data.length === 0) return null;
  return assetFileUrl(data[0].id);
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
