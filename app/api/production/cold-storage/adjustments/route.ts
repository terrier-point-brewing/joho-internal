import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export const dynamic = "force-dynamic";

// GET /api/production/cold-storage/adjustments
//
// The cold_storage_transforms journal, newest first — every internal
// reformatting of finished goods held in cold storage. Two kinds land here:
//
//   * Keg Transform — a human reshaped kegs, either way round: a 1/2 keg split
//     into sixtels, or sixtels combined back into a 1/2 keg. Lossy in both
//     directions: the shrinkage column is real beer that no longer exists.
//   * Pack Break — the taproom sold a single from a sealed case and
//     applyBreakDown cracked one automatically. Lossless by construction.
//
// shrinkage_fl_oz can be very slightly NEGATIVE on a build-up (3 x 661 - 1984 =
// -1). That is whole-fl-oz storage showing through, not beer appearing; the DB
// constraint caps it at half an ounce per unit. Consumers treat it as zero.
//
// This is the ONLY read surface for that journal, and the only place in the app
// where transform shrinkage is visible at all: the batch volume ledger
// deliberately never sees it, because a transform happens after a batch has been
// packaged out and closed (see the migration header for the full reasoning).
export async function GET() {
  try { await requirePermission(CAP.exportRead); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("cold_storage_transforms")
    .select(
      "id, occurred_at, batch_id, recipe_id, from_units, to_units, " +
      "from_volume_fl_oz, to_volume_fl_oz, shrinkage_fl_oz, note, source_ref, created_by, " +
      "brew_batches(beer_name, batch_number), " +
      "from_variation:packaging_variations!cold_storage_transforms_from_variation_id_fkey(" +
        "name, container:packaging_items!packaging_variations_container_id_fkey(type)), " +
      "to_variation:packaging_variations!cold_storage_transforms_to_variation_id_fkey(name)",
    )
    .order("occurred_at", { ascending: false })
    .limit(500);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // The client is untyped and supabase-js can't infer a shape through aliased
  // embeds, so pin it once here rather than casting at each use.
  const raw = (data ?? []) as unknown as Record<string, unknown>[];

  // Resolve actor emails via profiles (the auth.users FK isn't in PostgREST's
  // schema cache) — same approach as /api/production/transfer-log.
  const actorIds = [...new Set(raw.map((r) => r.created_by).filter(Boolean))] as string[];
  let profileMap: Record<string, string> = {};
  if (actorIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, email")
      .in("id", actorIds);
    profileMap = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.email]));
  }

  type BatchRow = { beer_name: string | null; batch_number: string | null } | null;
  type FromVarRow = { name: string | null; container?: { type: string } | null } | null;
  type ToVarRow = { name: string | null } | null;

  const rows = raw.map((row) => {
    const batch = row.brew_batches as unknown as BatchRow;
    const fromVar = row.from_variation as unknown as FromVarRow;
    const toVar = row.to_variation as unknown as ToVarRow;
    const shrinkageFlOz = Number(row.shrinkage_fl_oz ?? 0);
    const createdBy = (row.created_by as string | null) ?? null;

    return {
      id: row.id as string,
      occurred_at: row.occurred_at as string,
      batch_id: row.batch_id as string,
      recipe_id: (row.recipe_id as string | null) ?? null,
      // Kind comes from what was physically reshaped, not from whether an actor
      // is recorded — a keg transform is a keg transform however it got here.
      kind: fromVar?.container?.type === "keg" ? ("keg_transform" as const) : ("pack_break" as const),
      beer_name: batch?.beer_name ?? null,
      batch_number: batch?.batch_number ?? null,
      from_variation_name: fromVar?.name ?? null,
      to_variation_name: toVar?.name ?? null,
      from_units: Number(row.from_units),
      to_units: Number(row.to_units),
      shrinkage_fl_oz: shrinkageFlOz,
      shrinkage_bbl: shrinkageFlOz / BBL_TO_FL_OZ,
      note: (row.note as string | null) ?? null,
      // An automatic break carries the triggering sale's trace key and no actor;
      // a manual transform carries an actor and no trace key.
      source_ref: (row.source_ref as string | null) ?? null,
      created_by_email: createdBy ? (profileMap[createdBy] ?? null) : null,
    };
  });

  return NextResponse.json(rows);
}
