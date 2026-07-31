import type { BrandCanon } from "./canon.types";
import type { BrandTemplate } from "./templates";
import type { BrandSeason } from "./seasons";

/**
 * Brand outputs — the record of every artifact the system produces.
 *
 * An output is not just a file path. It is the answer to "what exactly did we
 * ship, and could we produce it again byte for byte?" — so it records the
 * template VERSION, the canon it resolved tokens from, the resolved token values
 * themselves, and the exact asset ids used.
 *
 * Nothing an agent produces may skip the human gate: agent drafts land here with
 * status 'draft' and source 'agent', and reaching 'approved' is a human action.
 */

export type OutputStatus = "draft" | "approved" | "exported";

export interface BrandOutput {
  id: string;
  template_id: string;
  template_version: number;
  rendition: string;
  season_id: string | null;
  label_id: string | null;
  inputs: Record<string, unknown>;
  canon_version_id: string | null;
  tokens_snapshot: Record<string, string>;
  asset_refs: { slot: string; assetId: string }[];
  status: OutputStatus;
  source: "human" | "agent";
  rendered_path: string | null;
  render_meta: Record<string, unknown>;
  created_at?: string;
  approved_at?: string | null;
  exported_at?: string | null;
}

interface QueryChain {
  eq(column: string, value: string): QueryChain;
  order(
    column: string,
    opts?: { ascending?: boolean },
  ): Promise<{ data: BrandOutput[] | null; error: unknown }>;
  limit(n: number): Promise<{ data: BrandOutput[] | null; error: unknown }>;
}

export interface SupabaseLikeClient {
  from(table: string): {
    select(columns: string): QueryChain;
    insert(row: Record<string, unknown>): {
      select(): { single(): Promise<{ data: BrandOutput | null; error: unknown }> };
    };
    update(patch: Record<string, unknown>): {
      eq(column: string, value: string): Promise<{ error: unknown }>;
    };
  };
}

const TABLE = "brand_outputs";

/**
 * The token values an output was rendered with, flattened role → hex.
 *
 * Snapshotting the RESOLVED values rather than the roleMap is the point: a
 * roleMap is a set of pointers into a palette that can move underneath it, so
 * storing it would record which token was used without recording what it was.
 */
export function snapshotTokens(canon: BrandCanon, mode: "light" | "dark" = "light"): Record<string, string> {
  const byKey = new Map((canon.palette ?? []).map((c) => [c.key, c.hex]));
  const roles = canon.roleMap?.[mode] ?? {};
  const snapshot: Record<string, string> = {};
  for (const [role, key] of Object.entries(roles)) {
    if (typeof key !== "string") continue;
    const hex = byKey.get(key);
    if (hex) snapshot[role] = hex;
  }
  return snapshot;
}

/**
 * Pull the exact asset ids out of a resolved input set.
 *
 * `asset_refs` is what makes the decision not to version assets sufficient:
 * every upload already has an immutable id and its own bytes, so naming the ids
 * an output drew from pins it forever, even after a newer asset of the same
 * kind and variant has been approved over it.
 */
export function collectAssetRefs(
  template: Pick<BrandTemplate, "slots">,
  inputs: Record<string, unknown>,
  season?: BrandSeason | null,
): { slot: string; assetId: string }[] {
  const refs: { slot: string; assetId: string }[] = [];
  for (const slot of template.slots ?? []) {
    if (slot.type === "asset") {
      const id = inputs[slot.key];
      if (typeof id === "string" && id) refs.push({ slot: slot.key, assetId: id });
    }
    if (slot.type === "motif" && season) {
      const id =
        slot.resolves === "chop-glyph"
          ? season.chop_glyph_asset_id
          : slot.resolves === "season-logo"
            ? season.season_logo_asset_id
            : null;
      if (id) refs.push({ slot: slot.key, assetId: id });
    }
  }
  return refs;
}

export async function listOutputs(
  client: SupabaseLikeClient,
  filter?: { labelId?: string; templateId?: string; status?: OutputStatus },
): Promise<BrandOutput[]> {
  let query = client.from(TABLE).select("*");
  if (filter?.labelId) query = query.eq("label_id", filter.labelId);
  if (filter?.templateId) query = query.eq("template_id", filter.templateId);
  if (filter?.status) query = query.eq("status", filter.status);
  const { data } = await query.order("created_at", { ascending: false });
  return data ?? [];
}

export async function createOutput(
  client: SupabaseLikeClient,
  row: {
    template_id: string;
    template_version: number;
    rendition: string;
    inputs: Record<string, unknown>;
    tokens_snapshot: Record<string, string>;
    asset_refs: { slot: string; assetId: string }[];
    season_id?: string | null;
    label_id?: string | null;
    canon_version_id?: string | null;
    source?: "human" | "agent";
  },
): Promise<BrandOutput> {
  const { data, error } = await client
    .from(TABLE)
    .insert({
      ...row,
      season_id: row.season_id ?? null,
      label_id: row.label_id ?? null,
      canon_version_id: row.canon_version_id ?? null,
      // Always 'draft', including for a human. Approval is a separate act, and
      // an insert that could land pre-approved is one refactor away from an
      // agent doing the same.
      status: "draft",
      source: row.source ?? "human",
      rendered_path: null,
      render_meta: {},
    })
    .select()
    .single();
  if (error || !data) throw new Error("Failed to create output");
  return data;
}

export async function approveOutput(client: SupabaseLikeClient, id: string): Promise<void> {
  const { error } = await client
    .from(TABLE)
    .update({ status: "approved", approved_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error("Failed to approve output");
}

/**
 * Mark an output exported. Only an APPROVED output may be exported — the review
 * gate is the whole point of the status ladder, and skipping it is exactly what
 * an automated caller would do by accident.
 */
export async function markExported(
  client: SupabaseLikeClient,
  id: string,
  renderedPath: string,
): Promise<void> {
  const { data: rows } = await client.from(TABLE).select("*").eq("id", id).limit(1);
  const output = rows?.[0];
  if (!output) throw new Error("Output not found");
  if (output.status !== "approved") {
    throw new Error(`Cannot export an output that is ${output.status} — approve it first.`);
  }

  const { error } = await client
    .from(TABLE)
    .update({
      status: "exported",
      rendered_path: renderedPath,
      exported_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error("Failed to mark output exported");
}
