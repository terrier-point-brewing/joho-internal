import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getShortfalls } from "@/lib/production/commitments";

export const dynamic = "force-dynamic";

/**
 * GET /api/production/ingredient-shortfalls?batch_id=<uuid>
 *
 * Returns shortfalls for a single batch.  The UI uses this to show a warning
 * badge on batch rows before the batch hits the brewhouse.
 */
export async function GET(req: NextRequest) {
  const batchId = req.nextUrl.searchParams.get("batch_id");
  if (!batchId) return NextResponse.json({ error: "batch_id is required" }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const shortfalls = await getShortfalls(supabase, batchId);
  return NextResponse.json(shortfalls);
}
