import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET /api/production/export-bay/inventory
// Returns available cold-storage inventory grouped by recipe + packaging
// variation, summed across every batch — the Export Bay's "Available" column.
// No batch breakdown is exposed; from a shipping standpoint the user only
// cares about total units on hand per recipe+variation.
export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("cold_storage_inventory")
    .select("recipe_id, variation_id, quantity_on_hand, packaging_variations(name, total_volume_fl_oz, container:packaging_items!packaging_variations_container_id_fkey(type))")
    .not("recipe_id", "is", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type PVRow = { name: string; total_volume_fl_oz: number | null; container?: { type: string } | null } | null;
  const grouped = new Map<string, { recipe_id: string; variation_id: string; variation_name: string; container_type: string | null; total_volume_fl_oz: number | null; quantity_on_hand: number }>();
  for (const row of data ?? []) {
    const key = `${row.recipe_id}|${row.variation_id}`;
    const pv = row.packaging_variations as unknown as PVRow;
    const variationName = pv?.name ?? "Unknown variation";
    const containerType = pv?.container?.type ?? null;
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity_on_hand += Number(row.quantity_on_hand);
    } else {
      grouped.set(key, {
        recipe_id: row.recipe_id as string,
        variation_id: row.variation_id,
        variation_name: variationName,
        container_type: containerType,
        total_volume_fl_oz: pv?.total_volume_fl_oz != null ? Number(pv.total_volume_fl_oz) : null,
        quantity_on_hand: Number(row.quantity_on_hand),
      });
    }
  }

  const lines = [...grouped.values()].filter((l) => l.quantity_on_hand > 0.001);
  return NextResponse.json(lines);
}
