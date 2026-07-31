import { slotsSchema, renditionsSchema, type Rendition, type Slot } from "./slots";

/**
 * Brand templates — the base layout, its slots, and the sizes it renders at.
 *
 * Same injected-client testability pattern as canonWorkflow.ts / assets.ts:
 * callers pass createSupabaseAdminClient() in production, a fake in tests.
 *
 * Templates are VERSIONED, unlike assets. An asset is a file and every upload
 * already has its own immutable id; a template is data edited in place, so
 * reproducing an old render needs the slot set as it was. Publishing therefore
 * cuts a new version rather than mutating the live one.
 */

export type TemplateMedium =
  | "label"
  | "menu"
  | "social"
  | "apparel"
  | "signage"
  | "collateral";

export interface BrandTemplate {
  id: string;
  key: string;
  version: number;
  name: string;
  medium: TemplateMedium;
  status: "draft" | "published" | "archived";
  base_svg_path: string | null;
  slots: Slot[];
  constraints: Record<string, unknown>;
  renditions: Rendition[];
  notes: string | null;
  created_at?: string;
  published_at?: string | null;
}

interface QueryChain {
  eq(column: string, value: string | number): QueryChain;
  order(
    column: string,
    opts?: { ascending?: boolean },
  ): Promise<{ data: BrandTemplate[] | null; error: unknown }>;
  limit(n: number): Promise<{ data: BrandTemplate[] | null; error: unknown }>;
}

export interface SupabaseLikeClient {
  from(table: string): {
    select(columns: string): QueryChain;
    insert(row: Record<string, unknown>): {
      select(): { single(): Promise<{ data: BrandTemplate | null; error: unknown }> };
    };
    update(patch: Record<string, unknown>): {
      eq(column: string, value: string): Promise<{ error: unknown }>;
    };
  };
}

const TABLE = "brand_templates";

/**
 * Validate the authored parts of a template.
 *
 * Slots and renditions are the two fields a renderer trusts blindly, and both
 * are free-form jsonb in the database — a duplicate slot key or a rendition
 * with no output format is accepted by Postgres and only fails much later, at
 * render time, with a message about something else. Checked on write instead.
 */
export function validateTemplateShape(input: {
  slots?: unknown;
  renditions?: unknown;
}): string[] {
  const problems: string[] = [];

  const slots = slotsSchema.safeParse(input.slots ?? []);
  if (!slots.success) {
    for (const issue of slots.error.issues) {
      problems.push(`slots${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`);
    }
  }

  const renditions = renditionsSchema.safeParse(input.renditions ?? []);
  if (!renditions.success) {
    for (const issue of renditions.error.issues) {
      problems.push(
        `renditions${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`,
      );
    }
  }

  return problems;
}

export async function listTemplates(
  client: SupabaseLikeClient,
  filter?: { medium?: TemplateMedium; status?: BrandTemplate["status"] },
): Promise<BrandTemplate[]> {
  let query = client.from(TABLE).select("*");
  if (filter?.medium) query = query.eq("medium", filter.medium);
  if (filter?.status) query = query.eq("status", filter.status);
  const { data } = await query.order("created_at", { ascending: false });
  return data ?? [];
}

/** The live version of a template, or null when nothing is published yet. */
export async function getPublishedTemplate(
  client: SupabaseLikeClient,
  key: string,
): Promise<BrandTemplate | null> {
  const { data } = await client
    .from(TABLE)
    .select("*")
    .eq("key", key)
    .eq("status", "published")
    .limit(1);
  return data?.[0] ?? null;
}

/**
 * The exact version an output was rendered against.
 *
 * Outputs store (template_id, template_version) rather than the id alone, so a
 * lookup by key+version keeps working after the row is archived — which is the
 * whole point of recording the version.
 */
export async function getTemplateVersion(
  client: SupabaseLikeClient,
  key: string,
  version: number,
): Promise<BrandTemplate | null> {
  const { data } = await client
    .from(TABLE)
    .select("*")
    .eq("key", key)
    .eq("version", version)
    .limit(1);
  return data?.[0] ?? null;
}

export async function createTemplate(
  client: SupabaseLikeClient,
  row: {
    key: string;
    name: string;
    medium: TemplateMedium;
    slots?: Slot[];
    renditions?: Rendition[];
    constraints?: Record<string, unknown>;
    base_svg_path?: string | null;
    notes?: string | null;
  },
): Promise<BrandTemplate> {
  const problems = validateTemplateShape(row);
  if (problems.length > 0) throw new Error(problems.join("; "));

  const { data, error } = await client
    .from(TABLE)
    .insert({
      key: row.key,
      name: row.name,
      medium: row.medium,
      version: 1,
      status: "draft",
      slots: row.slots ?? [],
      renditions: row.renditions ?? [],
      constraints: row.constraints ?? {},
      base_svg_path: row.base_svg_path ?? null,
      notes: row.notes ?? null,
    })
    .select()
    .single();
  if (error || !data) throw new Error("Failed to create template");
  return data;
}

export async function updateTemplate(
  client: SupabaseLikeClient,
  id: string,
  patch: Partial<Omit<BrandTemplate, "id" | "key" | "version">>,
): Promise<void> {
  const problems = validateTemplateShape(patch);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const { error } = await client.from(TABLE).update(patch).eq("id", id);
  if (error) throw new Error("Failed to update template");
}

/**
 * Publish a draft: archive the prior published version of the same key, then
 * flip this one.
 *
 * Archive-before-write, mirroring canonWorkflow.publishDraft and
 * assets.approveAsset — the brand_templates_one_published partial unique index
 * forbids two published rows per key, so publish-then-archive would violate it
 * on every release after the first.
 */
export async function publishTemplate(client: SupabaseLikeClient, id: string): Promise<void> {
  const { data: targets } = await client.from(TABLE).select("*").eq("id", id).limit(1);
  const target = targets?.[0];
  if (!target) throw new Error("Template not found");

  const problems = validateTemplateShape(target);
  if (problems.length > 0) throw new Error(`Cannot publish: ${problems.join("; ")}`);

  const { data: live } = await client
    .from(TABLE)
    .select("*")
    .eq("key", target.key)
    .eq("status", "published")
    .limit(1);
  const current = live?.[0];

  if (current && current.id !== target.id) {
    await client.from(TABLE).update({ status: "archived" }).eq("id", current.id);
  }

  const { error } = await client
    .from(TABLE)
    .update({ status: "published", published_at: new Date().toISOString() })
    .eq("id", target.id);
  if (error) throw new Error("Failed to publish template");
}

/**
 * Start a new draft from a published version, at version + 1.
 *
 * Editing a published template in place would rewrite history for every output
 * that points at it, so a change always begins as a new version.
 */
export async function draftNextVersion(
  client: SupabaseLikeClient,
  id: string,
): Promise<BrandTemplate> {
  const { data: sources } = await client.from(TABLE).select("*").eq("id", id).limit(1);
  const source = sources?.[0];
  if (!source) throw new Error("Template not found");

  const { data, error } = await client
    .from(TABLE)
    .insert({
      key: source.key,
      version: source.version + 1,
      name: source.name,
      medium: source.medium,
      status: "draft",
      base_svg_path: source.base_svg_path,
      slots: source.slots,
      constraints: source.constraints,
      renditions: source.renditions,
      notes: source.notes,
    })
    .select()
    .single();
  if (error || !data) throw new Error("Failed to draft the next version");
  return data;
}
