import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/production/transfer-log
 *
 * Cross-batch chronological transfer log with actor, batch, equipment, and
 * packaging output (units, variation, and the beer an in-keg conversion
 * produced) joined in. Supports optional filtering:
 *   ?batch_id=<uuid>         — single batch
 *   ?from=<YYYY-MM-DD>       — transferred_at >= date
 *   ?to=<YYYY-MM-DD>         — transferred_at <= date
 *   ?type=<transfer_type>    — e.g. kegging, canning, transfer, conversion
 */
export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { searchParams } = new URL(req.url);

  const batch_id = searchParams.get("batch_id");
  const from     = searchParams.get("from");
  const to       = searchParams.get("to");
  const type     = searchParams.get("type");

  let query = supabase
    .from("batch_transfers")
    .select(`
      id,
      batch_id,
      from_tank_id,
      to_tank_id,
      volume_bbl,
      shrinkage_bbl,
      transfer_type,
      notes,
      transferred_at,
      to_batch_id,
      created_by,
      quantity,
      batch:brew_batches!batch_transfers_batch_id_fkey ( id, beer_name, batch_number ),
      packaging_variations ( id, name ),
      packaged_as:packaged_as_recipe_id ( id, beer_name ),
      from_tank:from_tank_id ( id, name, type ),
      to_tank:to_tank_id     ( id, name, type ),
      to_batch:to_batch_id   ( id, beer_name, batch_number )
    `)
    .order("transferred_at", { ascending: false });

  if (batch_id) query = query.eq("batch_id", batch_id);
  if (from)     query = query.gte("transferred_at", from);
  if (to)       query = query.lte("transferred_at", to + "T23:59:59Z");
  if (type)     query = query.eq("transfer_type", type);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Resolve actor emails via profiles (auth.users FK isn't in PostgREST schema cache).
  const actorIds = [...new Set((data ?? []).map((r) => r.created_by).filter(Boolean))];
  let profileMap: Record<string, string> = {};
  if (actorIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, email")
      .in("id", actorIds);
    profileMap = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.email]));
  }

  const enriched = (data ?? []).map((r) => ({
    ...r,
    created_by_profile: r.created_by ? { email: profileMap[r.created_by] ?? null } : null,
  }));

  return NextResponse.json(enriched);
}
