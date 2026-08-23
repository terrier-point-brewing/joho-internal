// lib/finance/glDefaultRules.ts
//
// Standing GL defaults for a Square catalog scope — the memory a bulk map used
// to lack.
//
// Bulk mapping fans out over the variations that exist at the moment it runs.
// Anything Square adds afterwards arrives with a null CoA and reads as
// unresolved, even though a person already decided what that category codes to.
// A rule records that decision so the catalog sync can apply it to a variation
// the mirror has never seen.
//
// A rule is a DEFAULT, not an enforcement. It only ever touches variations on
// first sight; an operator who re-points one row by hand keeps that choice for
// good, and nothing here revisits an existing mapping.

import type { SupabaseClient } from "@supabase/supabase-js";

export type GlRuleScope = "parent" | "category" | "item";

/** The four things a rule can declare. NULL on any = "says nothing about it". */
export interface GlRuleFields {
  chart_of_accounts_id: string | null;
  chart_of_accounts_id_pos: string | null;
  chart_of_accounts_id_invoice: string | null;
  excluded: boolean | null;
}

export interface GlDefaultRule extends GlRuleFields {
  id?: string;
  scope: GlRuleScope;
  /**
   * Square category id for parent/category, square_catalog_items.id for item.
   * NULL is a real scope — the Uncategorized group — not a missing value.
   */
  scope_key: string | null;
}

/** Where one variation sits in the mapping tree. */
export interface VariationScope {
  square_variation_id: string;
  /** square_catalog_items.id — the item-scope key. */
  catalog_item_id: string;
  /** Square category id, or null for uncategorized. */
  category_id: string | null;
  /** Effective parent: parent_category_id ?? category_id, matching the bulk route. */
  parent_group_id: string | null;
}

/** What to write onto a variation. Empty object = no rule reached it. */
export type GlDefaultPatch = Partial<GlRuleFields>;

const CO_A_FIELDS = [
  "chart_of_accounts_id",
  "chart_of_accounts_id_pos",
  "chart_of_accounts_id_invoice",
] as const;

/**
 * Resolve the standing default for one variation.
 *
 * Precedence is per FIELD, narrowest first: item, then category, then parent.
 * Field-wise rather than whole-rule because the levels declare different things
 * — an item rule that only sets a POS override must not knock out the category's
 * default account, which is exactly what "the narrowest matching rule wins
 * outright" would do.
 *
 * `excluded` is only ever applied when a rule says TRUE. A rule that has never
 * been asked about exclusion holds NULL, and FALSE would be a positive claim no
 * bulk action makes.
 */
export function resolveGlDefaultPatch(rules: GlDefaultRule[], scope: VariationScope): GlDefaultPatch {
  const byNarrowest: (GlDefaultRule | undefined)[] = [
    rules.find((r) => r.scope === "item"     && r.scope_key === scope.catalog_item_id),
    rules.find((r) => r.scope === "category" && r.scope_key === scope.category_id),
    rules.find((r) => r.scope === "parent"   && r.scope_key === scope.parent_group_id),
  ];

  const patch: GlDefaultPatch = {};
  for (const field of CO_A_FIELDS) {
    const hit = byNarrowest.find((r) => r?.[field] != null);
    if (hit) patch[field] = hit[field];
  }
  const excludedHit = byNarrowest.find((r) => r?.excluded != null);
  if (excludedHit?.excluded === true) patch.excluded = true;

  return patch;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient | { from: (t: string) => any };

/**
 * Record (or update) the standing default for a scope.
 *
 * Merges rather than replaces: bulk-mapping a category and later bulk-excluding
 * it are two separate declarations about the same scope, and one row holds both.
 * Only the fields the caller actually set are touched.
 *
 * PostgREST cannot upsert against the partial unique indexes this table uses
 * (scope_key is nullable and NULL is meaningful), so this reads then writes.
 */
export async function upsertGlDefaultRule(
  db: Db,
  scope: GlRuleScope,
  scopeKey: string | null,
  fields: GlDefaultPatch,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (db as any).from("square_gl_default_rules").select("id").eq("scope", scope);
  q = scopeKey === null ? q.is("scope_key", null) : q.eq("scope_key", scopeKey);
  const { data: existing, error: readErr } = await q.limit(1);
  if (readErr) throw new Error(readErr.message);

  const row = (existing ?? [])[0] as { id: string } | undefined;
  const { error } = row
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? await (db as any).from("square_gl_default_rules").update(fields).eq("id", row.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : await (db as any).from("square_gl_default_rules").insert({ scope, scope_key: scopeKey, ...fields });
  if (error) throw new Error(error.message);
}

/** Every standing rule. Small table — one row per scope a human has bulk-mapped. */
export async function listGlDefaultRules(db: Db): Promise<GlDefaultRule[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from("square_gl_default_rules")
    .select("id, scope, scope_key, chart_of_accounts_id, chart_of_accounts_id_pos, chart_of_accounts_id_invoice, excluded");
  if (error) throw new Error(error.message);
  return (data ?? []) as GlDefaultRule[];
}

export interface ApplyRulesResult {
  /** Variations that matched a rule and were written. */
  applied: number;
  /** Non-fatal failure. A sync must not die because a default could not land. */
  error?: string;
}

/**
 * Apply the standing rules to variations the mirror has just seen for the first
 * time.
 *
 * Called with the ids a sync INSERTED, never the ones it refreshed — a rule is a
 * default for new arrivals, not a periodic re-stamping of the catalog.
 */
export async function applyGlDefaultRulesToNewVariations(
  db: Db,
  squareVariationIds: string[],
): Promise<ApplyRulesResult> {
  if (squareVariationIds.length === 0) return { applied: 0 };

  try {
    const rules = await listGlDefaultRules(db);
    if (rules.length === 0) return { applied: 0 };

    let applied = 0;
    for (let i = 0; i < squareVariationIds.length; i += 200) {
      const chunk = squareVariationIds.slice(i, i + 200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (db as any)
        .from("square_catalog_variations")
        .select("square_variation_id, catalog_item_id, square_catalog_items!inner(id, category_id, parent_category_id)")
        .in("square_variation_id", chunk);
      if (error) throw new Error(error.message);

      type Row = {
        square_variation_id: string;
        catalog_item_id: string;
        square_catalog_items: { id: string; category_id: string | null; parent_category_id: string | null } | null;
      };

      for (const r of (data ?? []) as Row[]) {
        const item = r.square_catalog_items;
        if (!item) continue;
        const patch = resolveGlDefaultPatch(rules, {
          square_variation_id: r.square_variation_id,
          catalog_item_id: item.id,
          category_id: item.category_id,
          parent_group_id: item.parent_category_id ?? item.category_id,
        });
        if (Object.keys(patch).length === 0) continue;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: upErr } = await (db as any)
          .from("square_catalog_variations")
          .update(patch)
          .eq("square_variation_id", r.square_variation_id);
        if (upErr) throw new Error(upErr.message);
        applied++;
      }
    }
    return { applied };
  } catch (e) {
    return { applied: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
