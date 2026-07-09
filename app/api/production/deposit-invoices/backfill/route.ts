// app/api/production/deposit-invoices/backfill/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildBreakdownLines, snapshotDepositBreakdown } from "@/lib/production/depositBreakdown";
import {
  reconstructBreakdownAsOf,
  type AuditRow,
  type RecipeIngredientNow,
  type IngredientNow,
} from "@/lib/production/depositReconstruction";

export const dynamic = "force-dynamic";

// POST { apply?: boolean } — reconstruct + (optionally) write frozen breakdowns
// for every existing deposit invoice. Admin only. Dry-run unless apply === true.
export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const body = await req.json().catch(() => ({}));
  const apply = body?.apply === true;
  const db = createSupabaseAdminClient();

  const { data: invoices, error } = await db
    .from("invoices")
    .select("id, total_cents, invoice_date, allocation_id, batch_allocations!allocation_id(percentage, invoice_generated_at, invoice_sent_at, invoice_paid_at, batch_id, brew_batches(recipe_id))")
    .eq("invoice_type", "allocation_deposit")
    .not("allocation_id", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Array<{ invoice_id: string; status: string; lines: number; sum_cents: number; total_cents: number }> = [];
  let written = 0, skipped = 0, errored = 0;

  const skip = (inv: { id: string; total_cents: number | null }, status: string) => {
    skipped++;
    results.push({ invoice_id: inv.id, status, lines: 0, sum_cents: 0, total_cents: inv.total_cents ?? 0 });
  };
  const fail = (inv: { id: string; total_cents: number | null }, status: string) => {
    errored++;
    results.push({ invoice_id: inv.id, status, lines: 0, sum_cents: 0, total_cents: inv.total_cents ?? 0 });
  };

  const auditSel = "table_name, record_id, operation, changed_at, old_data, new_data";

  for (const inv of invoices ?? []) {
    const alloc = inv.batch_allocations as unknown as {
      percentage: number | null; invoice_generated_at: string | null; invoice_sent_at: string | null;
      invoice_paid_at: string | null; brew_batches: { recipe_id: string | null } | null;
    } | null;
    const recipeId = alloc?.brew_batches?.recipe_id ?? null;
    if (!recipeId || !inv.total_cents) { skip(inv, "skipped:no-recipe-or-total"); continue; }

    const asOf =
      alloc!.invoice_generated_at ?? alloc!.invoice_sent_at ?? alloc!.invoice_paid_at ??
      (inv.invoice_date ? `${inv.invoice_date}T00:00:00Z` : null);
    if (!asOf) { skip(inv, "skipped:no-date"); continue; }

    const { data: ris, error: risErr } = await db
      .from("recipe_ingredients")
      .select("id, ingredient_id, quantity_per_bbl, ingredients(id, name, unit, cost_per_unit)")
      .eq("recipe_id", recipeId);
    if (risErr) { fail(inv, `error:recipe_ingredients:${risErr.message}`); continue; }

    const recipeIngredientsNow: RecipeIngredientNow[] = (ris ?? []).map((r) => {
      const rr = r as unknown as { id: string; ingredient_id: string; quantity_per_bbl: number };
      return { recipe_ingredient_id: rr.id, ingredient_id: rr.ingredient_id, quantity_per_bbl: Number(rr.quantity_per_bbl) };
    });
    const ingredientsNow = new Map<string, IngredientNow>(
      (ris ?? []).map((r) => {
        const rr = r as unknown as { ingredient_id: string; ingredients: { id: string; name: string; unit: string; cost_per_unit: number | null } };
        return [rr.ingredient_id, {
          id: rr.ingredients.id, name: rr.ingredients.name, unit: rr.ingredients.unit,
          cost_per_unit: rr.ingredients.cost_per_unit == null ? null : Number(rr.ingredients.cost_per_unit),
        }] as const;
      })
    );

    const { data: riAuditRaw, error: riAuditErr } = await db
      .from("audit_log")
      .select(auditSel)
      .eq("table_name", "recipe_ingredients")
      .or(`new_data->>recipe_id.eq.${recipeId},old_data->>recipe_id.eq.${recipeId}`);
    if (riAuditErr) { fail(inv, `error:recipe_ingredient_audit:${riAuditErr.message}`); continue; }
    const recipeIngredientAudit = (riAuditRaw ?? []) as AuditRow[];

    const ingredientIdUniverse = new Set<string>(recipeIngredientsNow.map((r) => r.ingredient_id));
    for (const r of recipeIngredientAudit) {
      const nid = r.new_data?.["ingredient_id"];
      const oid = r.old_data?.["ingredient_id"];
      if (typeof nid === "string") ingredientIdUniverse.add(nid);
      if (typeof oid === "string") ingredientIdUniverse.add(oid);
    }
    const ingIds = [...ingredientIdUniverse];
    let ingredientAudit: AuditRow[] = [];
    if (ingIds.length) {
      const { data: ingAuditRaw, error: ingAuditErr } = await db
        .from("audit_log").select(auditSel).eq("table_name", "ingredients").in("record_id", ingIds);
      if (ingAuditErr) { fail(inv, `error:ingredient_audit:${ingAuditErr.message}`); continue; }
      ingredientAudit = (ingAuditRaw ?? []) as AuditRow[];
    }

    const inputs = reconstructBreakdownAsOf({
      asOf,
      currentRecipeIngredients: recipeIngredientsNow,
      ingredientsNow,
      recipeIngredientAudit,
      ingredientAudit,
    });
    const lines = buildBreakdownLines(inputs, inv.total_cents);

    if (lines.length === 0) { skip(inv, "skipped:no-lines"); continue; }

    const sum = lines.reduce((s, l) => s + l.line_total_cents, 0);
    results.push({ invoice_id: inv.id, status: apply ? "written" : "dry-run", lines: lines.length, sum_cents: sum, total_cents: inv.total_cents });

    if (apply) {
      await snapshotDepositBreakdown(db, inv.id, inputs, inv.total_cents);
      written++;
    }
  }

  return NextResponse.json({
    mode: apply ? "apply" : "dry-run",
    summary: { total: invoices?.length ?? 0, written, skipped, errored },
    results,
  });
}
