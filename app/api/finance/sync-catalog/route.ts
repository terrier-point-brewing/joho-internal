import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncSquareCatalog } from "@/lib/square/syncCatalog";

export const dynamic = "force-dynamic";

/**
 * Entry point for the Square catalog mirror sync. What it does lives in
 * lib/square/syncCatalog.ts so the deletion-marking pass can be unit tested.
 */
export async function POST() {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  // Bust the 5-min live-catalog cache so this sync — and every cached reader of
  // it, e.g. the taproom restock picker via /api/production/square-catalog —
  // sees Square's current catalog, not a stale entry. Without this a freshly
  // created item (like Draft Restock) won't appear in mapping pickers for up to
  // 5 minutes after a sync.
  revalidateTag("square-catalog", "max");

  try {
    const result = await syncSquareCatalog(createSupabaseAdminClient());
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
