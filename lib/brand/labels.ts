// The label component of a release (1:1 via release_id since migration
// 20260922110000): design inputs (Tier-2 palette, chop glyph) plus the three
// tracked stages of getting a label made — illustration commission,
// regulatory approval, print order. The release-card copy (name, story,
// naming check) lives on brand_releases now; the label's own name/subtitle/
// description columns are legacy and no longer edited. Same injected-client
// testability pattern as canonWorkflow.ts / assets.ts: callers pass
// createSupabaseAdminClient() in production, a fake client in tests.

export interface Tier2Palette {
  colors: { name: string; hex: string; note?: string }[];
}

export interface NamingCheck {
  results: { criterion: string; pass: boolean; note?: string }[];
}

/** Stage 1 — commission the illustration from an artist. */
export interface LabelIllustration {
  /** The request text sent to the artist, composed from guide + release card. */
  request_brief?: string;
  artist_name?: string;
  artist_contact?: string;
  requested_at?: string | null;
  expected_delivery?: string | null;
  /** Final illustration files, as brand_assets ids (kind `label_art`). */
  asset_ids?: string[];
  notes?: string;
}

/** Stage 2 — regulatory approval of the finished label. */
export interface LabelRegulatory {
  submitted_at?: string | null;
  approved?: boolean;
  approved_at?: string | null;
  /** Approval / filing reference number. */
  reference?: string;
  notes?: string;
}

/** Stage 3 — the print order. */
export interface LabelPrintOrder {
  printer?: string;
  quantity?: number | null;
  specs?: string;
  ordered_at?: string | null;
  received_at?: string | null;
  notes?: string;
}

export interface BrandLabel {
  id: string;
  release_id: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  motif_family: string | null;
  status: "draft" | "approved" | "archived";
  tier2_palette: Tier2Palette;
  naming_check: NamingCheck;
  chop_glyph_asset_id: string | null;
  illustration: LabelIllustration;
  regulatory: LabelRegulatory;
  print_order: LabelPrintOrder;
  /** The Production label SKU (packaging_items, type 'label') this design
   * prints onto — the frame reads live stock through it. */
  packaging_item_id: string | null;
}

export type StageStatus = "not_started" | "in_progress" | "done";

// Pure stage rollups. "Done" is each stage's operational gate: the final art
// is in hand, the approval came back, the order went out. Anything filled in
// short of that is "in progress".
export function illustrationStatus(ill: LabelIllustration | null | undefined): StageStatus {
  if (!ill) return "not_started";
  if ((ill.asset_ids?.length ?? 0) > 0) return "done";
  const touched = Boolean(
    ill.request_brief || ill.artist_name || ill.artist_contact || ill.requested_at || ill.expected_delivery || ill.notes,
  );
  return touched ? "in_progress" : "not_started";
}

export function regulatoryStatus(reg: LabelRegulatory | null | undefined): StageStatus {
  if (!reg) return "not_started";
  if (reg.approved) return "done";
  const touched = Boolean(reg.submitted_at || reg.reference || reg.notes || reg.approved_at);
  return touched ? "in_progress" : "not_started";
}

export function printOrderStatus(po: LabelPrintOrder | null | undefined): StageStatus {
  if (!po) return "not_started";
  if (po.ordered_at) return "done";
  const touched = Boolean(po.printer || po.quantity || po.specs || po.received_at || po.notes);
  return touched ? "in_progress" : "not_started";
}

/** The Label card's chip: done only when all three stages are done. */
export function labelComponentStatus(label: BrandLabel | null | undefined): StageStatus {
  if (!label) return "not_started";
  const stages = [
    illustrationStatus(label.illustration),
    regulatoryStatus(label.regulatory),
    printOrderStatus(label.print_order),
  ];
  if (stages.every((s) => s === "done")) return "done";
  if (stages.some((s) => s !== "not_started")) return "in_progress";
  // Design inputs alone (palette, chop) also count as started.
  const touched = Boolean(label.chop_glyph_asset_id || label.tier2_palette?.colors?.length);
  return touched ? "in_progress" : "not_started";
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
  row: { release_id: string; name: string },
): Promise<BrandLabel> {
  const { data, error } = await client
    .from(TABLE)
    .insert({
      release_id: row.release_id,
      // Legacy column, still not-null; mirrors the release name at creation.
      name: row.name,
      subtitle: null,
      description: null,
      motif_family: null,
      status: "draft",
      tier2_palette: { colors: [] },
      naming_check: { results: [] },
      chop_glyph_asset_id: null,
      illustration: {},
      regulatory: {},
      print_order: {},
      packaging_item_id: null,
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
