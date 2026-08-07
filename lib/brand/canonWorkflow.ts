import { canonSchema } from "./canon.schema";
import type { BrandCanon } from "./canon.types";
import { withIds } from "./canonIds";
import { SECTION_KEYS, sectionOf, sectionSchema } from "./canonSections";
import { diffCanon, renderChangelog, type ChangeEntry } from "./diffCanon";
import type { GuideSectionKey } from "./guideIntros";
import { seedCanon } from "./seedCanon";

interface CanonRow {
  id: string;
  version_label: string;
  status: "draft" | "published" | "archived";
  document: BrandCanon;
  changelog: string | null;
  // Null on rows published before migration 20260902 — the UI falls back to the
  // flat `changelog` text for those.
  change_entries: ChangeEntry[] | null;
  published_at: string | null;
}

export interface CanonVersionSummary {
  id: string;
  version_label: string;
  status: "published" | "archived";
  published_at: string | null;
  changelog: string | null;
  change_entries: ChangeEntry[] | null;
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
//
// Also backfills stable list-item ids (lib/brand/canonIds.ts). This is how
// stored rows acquire ids without a data migration: read once, persist if
// anything was assigned, and every read after that is a no-op. withIds is
// idempotent, which is what stops this rewriting the row on every request.
export async function getDraft(client: SupabaseLikeClient): Promise<BrandCanon> {
  const existing = await getDraftRow(client);
  if (existing) {
    const { canon, changed } = withIds(existing.document);
    if (changed) {
      const { error } = await client
        .from(TABLE)
        .update({ document: canon })
        .eq("id", existing.id);
      assertOk(error, "backfill canon item ids");
    }
    return canon;
  }

  const published = await getCurrentPublished(client);
  const { canon: seedDocument } = withIds(published?.document ?? seedCanon);
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

// Writes ONE Brand Guide subtab's slice of the draft.
//
// The reason this exists: saveDraft() validates the entire document, so a stale
// or invalid field in any section blocked saving from every section. Here only
// `sectionSchema(section)` runs, so editing Ethos can't be held hostage by a
// malformed `naming` block three tabs away. Whole-document validation still
// happens — once, at publish, where it belongs (validateCanonForPublish).
//
// The stored draft is re-read inside this call and the patch merged into it.
// The client never sends a full document, so two admins editing different
// subtabs can't clobber each other's work.
export async function saveDraftSection(
  client: SupabaseLikeClient,
  section: GuideSectionKey,
  patch: Partial<BrandCanon>,
): Promise<void> {
  const owned = new Set<string>(SECTION_KEYS[section] as readonly string[]);

  // A section may write its own keys plus its own guideIntros entry — nothing
  // else. Rejecting loudly beats silently dropping: a patch carrying a foreign
  // key means the caller is confused, and swallowing it would hide the bug.
  const { guideIntros, ...rest } = patch;
  for (const key of Object.keys(rest)) {
    if (!owned.has(key)) {
      throw new Error(
        `Brand canon: section "${section}" may not write "${key}" (owned by another subtab)`,
      );
    }
  }
  if (guideIntros) {
    for (const key of Object.keys(guideIntros)) {
      if (key !== section) {
        throw new Error(
          `Brand canon: section "${section}" may not write the "${key}" introduction`,
        );
      }
    }
  }

  const parsed = Object.keys(rest).length > 0 ? sectionSchema(section).parse(rest) : {};

  // getDraft (not getDraftRow) so a first-ever section save still works — it
  // creates the seeded draft, which we then re-read to patch by id.
  await getDraft(client);
  const existing = await getDraftRow(client);
  if (!existing) throw new Error("Brand canon: no draft to patch");

  const nextDocument: BrandCanon = {
    ...existing.document,
    ...parsed,
    ...(guideIntros
      ? { guideIntros: { ...existing.document.guideIntros, ...guideIntros } }
      : {}),
  };

  const { error } = await client
    .from(TABLE)
    .update({ document: nextDocument })
    .eq("id", existing.id);
  assertOk(error, "save the canon draft section");
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
      .update({ document: parsed })
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

/** One thing wrong with a canon, attributed to the subtab that can fix it. */
export interface PublishIssue {
  section: GuideSectionKey | "other";
  path: string;
  message: string;
}

export type PublishValidation =
  | { ok: true; canon: BrandCanon }
  | { ok: false; issues: PublishIssue[] };

/**
 * Whole-document validation — the ONE place it happens. Section saves validate
 * only their own slice (saveDraftSection), so this is the gate that catches
 * anything that slipped through or was never edited.
 *
 * Issues are grouped by the subtab a human would open to fix them, so the
 * editor can say "Color: roleMap.light is missing accent" and link there,
 * rather than printing a raw Zod dump.
 */
export function validateCanonForPublish(doc: unknown): PublishValidation {
  const result = canonSchema.safeParse(doc);
  if (result.success) return { ok: true, canon: result.data };

  const issues: PublishIssue[] = result.error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    const rootKey = issue.path.length > 0 ? String(issue.path[0]) : "";
    return {
      section: sectionOf(rootKey) ?? "other",
      path: path || rootKey || "(document)",
      message: issue.message,
    };
  });

  return { ok: false, issues };
}

/** Renders a validation failure as a readable, subtab-grouped message. */
function describeIssues(issues: PublishIssue[]): string {
  const bySection = new Map<string, PublishIssue[]>();
  for (const issue of issues) {
    bySection.set(issue.section, [...(bySection.get(issue.section) ?? []), issue]);
  }

  const parts = [...bySection.entries()].map(
    ([section, list]) =>
      `${section}: ${list.map((i) => `${i.path} — ${i.message}`).join("; ")}`,
  );
  return `Cannot publish — fix these first. ${parts.join(" | ")}`;
}

/**
 * The stored `changelog` text: the generated summary, with any founder note
 * kept above it as context.
 *
 * The note is deliberately additive. Publishing used to record ONLY whatever an
 * admin typed into a small input, so the record of what actually changed
 * depended on someone remembering to describe it. Now the diff is the record
 * and the note is the commentary.
 */
function composeChangelog(entries: ChangeEntry[], note?: string): string | null {
  const generated = renderChangelog(entries);
  const trimmedNote = note?.trim();

  if (!trimmedNote) return generated || null;
  if (!generated) return trimmedNote;
  return `${trimmedNote}\n\n${generated}`;
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

  // Validate BEFORE touching any row. Archiving the prior published version and
  // only then discovering the draft is invalid would leave the brand with no
  // live canon at all.
  const validation = validateCanonForPublish(draft.document);
  if (!validation.ok) throw new Error(describeIssues(validation.issues));
  const parsed = validation.canon;

  const currentPublished = await getCurrentPublished(client);
  const versionLabel = opts.versionLabel ?? nextVersionLabel(currentPublished?.version_label ?? null);

  // Diff against the currently published document BEFORE it's archived — after
  // the archive step getCurrentPublished returns nothing and every publish
  // would look like a first publish, losing the real change list.
  const entries = diffCanon(currentPublished?.document ?? null, parsed);
  const changelog = composeChangelog(entries, opts.changelog);

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
    changelog,
    change_entries: entries,
    published_at: new Date().toISOString(),
  });
  assertOk(insertError, "publish the new canon version");

  const { error: deleteError } = await client.from(TABLE).delete().eq("id", draft.id);
  assertOk(deleteError, "clear the published draft");

  return { versionLabel };
}

// Published + archived rows, newest first (by published_at).
export async function listVersions(
  client: SupabaseLikeClient,
): Promise<CanonVersionSummary[]> {
  const { data, error } = await client
    .from(TABLE)
    .select("id, version_label, status, published_at, changelog, change_entries")
    .in("status", ["published", "archived"])
    .order("published_at", { ascending: false });
  assertOk(error, "list canon versions");

  return (data ?? []).map((row) => ({
    id: row.id,
    version_label: row.version_label,
    status: row.status as "published" | "archived",
    published_at: row.published_at,
    changelog: row.changelog,
    change_entries: row.change_entries ?? null,
  }));
}
