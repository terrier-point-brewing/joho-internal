import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { measureInventoryDrift } from "@/lib/production/inventoryDrift";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// Square vs cold storage, side by side. Split from /api/taproom/inventory because
// it makes several Square round-trips — the on-hand grid must not wait on them.
export async function GET() {
  try { await requirePermission(CAP.taproomPerformanceRead); } catch (res) { return res as Response; }

  try {
    const supabase = await createSupabaseServerClient();
    return NextResponse.json(await measureInventoryDrift(supabase));
  } catch (err) {
    return apiError(err);
  }
}
