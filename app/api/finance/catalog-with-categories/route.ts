import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Reads catalog items from the master DB table (populated via POST /api/finance/sync-catalog).
// Returns items grouped by category for the Account Mapping UI.
export async function GET() {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("square_catalog_items")
    .select("square_item_id, item_name, category_id, category_name")
    .order("category_name", { nullsFirst: false })
    .order("item_name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Derive unique category list from the items themselves
  const categoryMap = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.category_id && row.category_name && !categoryMap.has(row.category_id)) {
      categoryMap.set(row.category_id, row.category_name);
    }
  }

  return NextResponse.json({
    categories: [...categoryMap.entries()].map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    items: (data ?? []).map((r) => ({
      item_id:     r.square_item_id,
      item_name:   r.item_name,
      category_id: r.category_id,
    })),
    synced: data && data.length > 0,
  });
}
