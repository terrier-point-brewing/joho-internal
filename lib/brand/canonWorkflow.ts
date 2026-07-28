import { canonSchema } from "./canon.schema";
import type { BrandCanon } from "./canon.types";
import { seedCanon } from "./seedCanon";

interface CanonRow {
  id: string;
  version_label: string;
  status: "draft" | "published" | "archived";
  document: BrandCanon;
  changelog: string | null;
  published_at: string | null;
}

// Same injected-client testability pattern as getCanonFrom (lib/brand/getCanon.ts):
// callers pass createSupabaseAdminClient() in production, a fake client in tests.
export interface SupabaseLikeClient {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        limit(n: number): Promise<{ data: CanonRow[] | null; error: unknown }>;
      };
      in(
        column: string,
        values: string[],
      ): {
        order(
          column: string,
          opts?: { ascending?: boolean },
        ): Promise<{ data: CanonRow[] | null; error: unknown }>;
      };
    };
    insert(row: Record<string, unknown>): Promise<{ error: unknown }>;
    update(patch: Record<string, unknown>): {
      eq(column: string, value: string): Promise<{ error: unknown }>;
    };
    delete(): {
      eq(column: string, value: string): Promise<{ error: unknown }>;
    };
  };
}

const TABLE = "brand_canon_versions";

// Supabase's client RESOLVES with { error } on a failed query rather than
// throwing, so an unchecked call looks exactly like a successful one. That cost
// us the whole Brand Guide: prod was missing migration 20260809 (no
// `updated_at` column), every draft update came back PGRST204, the error was
// dropped, the route answered { ok: true }, and Publish snapshotted a draft
// that had never changed. Every query below routes through here so a write that
// didn't happen can never be reported as a write that did.
function assertOk(error: unknown, action: string): void {
  if (!error) return;
  const detail =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  throw new Error(`Brand canon: failed to ${action} — ${detail}`);
}

// Pure: bumps the minor version as an integer (never rolls to the next
// major). null (no prior published version) starts at "1.0".
export function nextVersionLabel(current: string | null): string {
  if (current === null) return "1.0";
  const [majorStr, minorStr] = current.split(".");
  const major = Number(majorStr);
  const minor = Number(minorStr);
  return `${major}.${minor + 1}`;
}

async function getCurrentPublished(client: SupabaseLikeClient): Promise<CanonRow | null> {
  const { data, error } = await client.from(TABLE).select("*").eq("status", "published").limit(1);
  assertOk(error, "read the published canon");
  return data && data.length > 0 ? data[0] : null;
}

// The draft row, or null when there isn't one. Shared by getDraft/saveDraft/
// publishDraft so the error check can't be forgotten at one of the three.
async function getDraftRow(client: SupabaseLikeClient): Promise<CanonRow | null> {
  const { data, error } = await client.from(TABLE).select("*").eq("status", "draft").limit(1);
  assertOk(error, "read the canon draft");
  return data && data.length > 0 ? data[0] : null;
}

// Returns the draft row's document. If no draft exists, seeds one from the
// current published row (or seedCanon if there's no published row either)
// and inserts it as the new draft.
export async function getDraft(client: SupabaseLikeClient): Promise<BrandCanon> {
  const existing = await getDraftRow(client);
  if (existing) return existing.document;

  const published = await getCurrentPublished(client);
  const seedDocument = published?.document ?? seedCanon;
  const { error } = await client.from(TABLE).insert({
    version_label: published?.version_label ?? "",
    status: "draft",
    document: seedDocument,
    changelog: null,
    published_at: null,
  });
  assertOk(error, "create the canon draft");
  return seedDocument;
}

// Validates, then updates the single existing draft row (or inserts one if
// none exists yet). NOT an upsert on (status): the `brand_canon_one_draft`
// partial unique index means a blind upsert without an id conflict target
// would insert a *second* draft and violate the index — so we update the
// existing draft explicitly by id, matching how getDraft() ensures one exists.
export async function saveDraft(client: SupabaseLikeClient, document: unknown): Promise<void> {
  const parsed = canonSchema.parse(document);
  const existing = await getDraftRow(client);
  if (existing) {
    const { error } = await client
      .from(TABLE)
      .update({ document: parsed, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    assertOk(error, "save the canon draft");
  } else {
    const { error } = await client.from(TABLE).insert({
      version_label: "",
      status: "draft",
      document: parsed,
      changelog: null,
      published_at: null,
    });
    assertOk(error, "save the canon draft");
  }
}

// Snapshots the current draft as a new published row, archives the prior
// published row (if any), and deletes the draft.
export async function publishDraft(
  client: SupabaseLikeClient,
  opts: { versionLabel?: string; changelog?: string },
): Promise<{ versionLabel: string }> {
  const draft = await getDraftRow(client);
  if (!draft) {
    throw new Error("No draft to publish");
  }
  const parsed = canonSchema.parse(draft.document);

  const currentPublished = await getCurrentPublished(client);
  const versionLabel = opts.versionLabel ?? nextVersionLabel(currentPublished?.version_label ?? null);

  // Archive the prior published row BEFORE inserting the new one. The
  // brand_canon_one_published partial unique index (migration 20260808)
  // forbids two published rows at once, so insert-then-archive would violate
  // the index and fail on every publish after the first.
  if (currentPublished) {
    const { error } = await client.from(TABLE).update({ status: "archived" }).eq("id", currentPublished.id);
    assertOk(error, "archive the prior published version");
  }

  const { error: insertError } = await client.from(TABLE).insert({
    version_label: versionLabel,
    status: "published",
    document: parsed,
    changelog: opts.changelog ?? null,
    published_at: new Date().toISOString(),
  });
  assertOk(insertError, "publish the new canon version");

  const { error: deleteError } = await client.from(TABLE).delete().eq("id", draft.id);
  assertOk(deleteError, "clear the published draft");

  return { versionLabel };
}

// Published + archived rows, newest first (by published_at).
export async function listVersions(client: SupabaseLikeClient): Promise<
  { id: string; version_label: string; status: "published" | "archived"; published_at: string | null; changelog: string | null }[]
> {
  const { data, error } = await client
    .from(TABLE)
    .select("id, version_label, status, published_at, changelog")
    .in("status", ["published", "archived"])
    .order("published_at", { ascending: false });
  assertOk(error, "list canon versions");

  return (data ?? []).map((row) => ({
    id: row.id,
    version_label: row.version_label,
    status: row.status as "published" | "archived",
    published_at: row.published_at,
    changelog: row.changelog,
  }));
}
