import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET /api/production/export-bay/inventory
// Returns available cold-storage inventory grouped by recipe + packaging
// variant, summed across every batch — the Export Bay's "Available" column.
// No batch breakdown is exposed; from a shipping standpoint the user only
// cares about total units on hand per recipe+variant.
export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("cold_storage_inventory")
    .select("recipe_id, packaging_item_id, variant_label, quantity_on_hand")
    .not("recipe_id", "is", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const grouped = new Map<string, { recipe_id: string; packaging_item_id: string; variant_label: string; quantity_on_hand: number }>();
  for (const row of data ?? []) {
    const key = `${row.recipe_id}|${row.packaging_item_id}|${row.variant_label}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity_on_hand += Number(row.quantity_on_hand);
    } else {
      grouped.set(key, {
        recipe_id: row.recipe_id as string,
        packaging_item_id: row.packaging_item_id,
        variant_label: row.variant_label,
        quantity_on_hand: Number(row.quantity_on_hand),
      });
    }
  }

  const lines = [...grouped.values()].filter((l) => l.quantity_on_hand > 0.001);
  return NextResponse.json(lines);
}
