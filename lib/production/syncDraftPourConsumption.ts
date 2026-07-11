import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchOrderSalesByDay } from "@/lib/square/inventory";
import { loadDraftPourVariations, aggregatePourFlOzByRecipeDay } from "@/lib/taproom/draftPourConsumption";

// Populate the operational pour ledger for the trailing `days` window. Additive and
// idempotent (upsert on recipe_id+business_date); never touches export_transactions.
export async function syncDraftPourConsumption(
  supabase: SupabaseClient,
  { days }: { days: number },
): Promise<{ recipesTouched: number; rowsUpserted: number }> {
  const pourVarsByRecipe = await loadDraftPourVariations(supabase);
  const varIds = [...pourVarsByRecipe.values()].flatMap((vs) => vs.map((v) => v.id));
  if (varIds.length === 0) return { recipesTouched: 0, rowsUpserted: 0 };

  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  const salesByDay = await fetchOrderSalesByDay(start, end, varIds);

  const rows = aggregatePourFlOzByRecipeDay(salesByDay, pourVarsByRecipe);
  if (rows.length > 0) {
    const { error } = await supabase
      .from("draft_pour_consumption")
      .upsert(rows, { onConflict: "recipe_id,business_date" });
    if (error) throw new Error(error.message);
  }
  return { recipesTouched: pourVarsByRecipe.size, rowsUpserted: rows.length };
}
