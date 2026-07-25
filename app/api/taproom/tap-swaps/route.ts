import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { buildRetirePayload } from "@/lib/taproom/retireRecipe";

export const dynamic = "force-dynamic";

/**
 * Queue / cancel a draft keg swap.
 *
 * A swap is queued in the app BEFORE the bartender rings Draft Restock. This route
 * only records the frozen note — it books nothing and deliberately leaves
 * `tap_assignments` alone, so the tap card keeps showing what is physically
 * pouring until the ring flips it (see taproomConsumptionSync).
 *
 * Both sides are snapshotted here, including the Square draft SKU ids, so no part
 * of booking the swap later depends on config that can be edited in the meantime.
 */

interface TapAssignmentSnapshot {
  recipe_id: string | null;
  swap_variation_id: string | null;
  swap_volume_fl_oz: number | null;
}

/** The recipe's Square draft base variation, or null when it has no draft link. */
async function draftSquareVariationId(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  recipeId: string | null,
): Promise<string | null> {
  if (!recipeId) return null;
  const { data } = await supabase
    .from("recipe_square_links")
    .select("square_variation_id")
    .eq("recipe_id", recipeId)
    .eq("packaging", "draft")
    .limit(1)
    .maybeSingle();
  return (data?.square_variation_id as string | undefined) ?? null;
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("tap_swap_transitions")
    .select("*")
    .is("consumed_source_ref", null)
    .order("opened_at");
  if (error) return apiError(error);
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  // Taproom managers run the tap list.
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  try {
    const body = await req.json() as {
      tap_number?: number;
      to_recipe_id?: string;
      to_variation_id?: string;
      retire_outgoing?: boolean;
    };
    const { tap_number, to_recipe_id, to_variation_id } = body;

    if (typeof tap_number !== "number" || !to_recipe_id || !to_variation_id) {
      return NextResponse.json(
        { error: "tap_number, to_recipe_id and to_variation_id are required" },
        { status: 400 },
      );
    }

    // One pending swap per tap. The UI hides the Swap action while one is queued,
    // so hitting this means a stale client or a double submit.
    const { data: existing, error: existingErr } = await supabase
      .from("tap_swap_transitions")
      .select("id")
      .eq("tap_number", tap_number)
      .is("consumed_source_ref", null)
      .limit(1);
    if (existingErr) return apiError(existingErr);
    if ((existing ?? []).length > 0) {
      return NextResponse.json(
        { error: `Tap ${tap_number} already has a queued swap. Cancel it first.` },
        { status: 409 },
      );
    }

    // Recount target always comes from the keg's coded volume — never the client.
    const { data: variation, error: varErr } = await supabase
      .from("packaging_variations")
      .select("total_volume_fl_oz")
      .eq("id", to_variation_id)
      .maybeSingle();
    if (varErr) return apiError(varErr);
    const toVolume = variation?.total_volume_fl_oz;
    if (toVolume == null) {
      return NextResponse.json(
        { error: "The selected keg has no coded volume, so it can't be a recount target." },
        { status: 400 },
      );
    }

    const { data: tapRow, error: tapErr } = await supabase
      .from("tap_assignments")
      .select("recipe_id, swap_variation_id, swap_volume_fl_oz")
      .eq("tap_number", tap_number)
      .maybeSingle();
    if (tapErr) return apiError(tapErr);
    const outgoing = (tapRow ?? { recipe_id: null, swap_variation_id: null, swap_volume_fl_oz: null }) as TapAssignmentSnapshot;

    const [fromDraftSku, toDraftSku] = await Promise.all([
      draftSquareVariationId(supabase, outgoing.recipe_id),
      draftSquareVariationId(supabase, to_recipe_id),
    ]);

    // Only claim the retire if THIS swap flips the flag — a beer already retired
    // beforehand must not be un-retired when this swap is cancelled.
    let alreadyRetired = false;
    if (outgoing.recipe_id) {
      const { data: settings } = await supabase
        .from("taproom_recipe_settings")
        .select("is_retired")
        .eq("recipe_id", outgoing.recipe_id)
        .maybeSingle();
      alreadyRetired = Boolean(settings?.is_retired);
    }
    const retireOutgoing = Boolean(body.retire_outgoing) && !!outgoing.recipe_id && !alreadyRetired;

    const { data: inserted, error: insertErr } = await supabase
      .from("tap_swap_transitions")
      .insert({
        tap_number,
        from_recipe_id:                 outgoing.recipe_id,
        from_variation_id:              outgoing.swap_variation_id,
        from_volume_fl_oz:              outgoing.swap_volume_fl_oz,
        from_draft_square_variation_id: fromDraftSku,
        to_recipe_id:                   to_recipe_id,
        to_variation_id:                to_variation_id,
        to_volume_fl_oz:                toVolume,
        to_draft_square_variation_id:   toDraftSku,
        retire_outgoing:                retireOutgoing,
      })
      .select("id")
      .single();
    if (insertErr) return apiError(insertErr);

    // The insert is the write that must not be lost; the retire is a convenience
    // the user can still do by hand, so a failure here is a warning, not a 500.
    let warning: string | null = null;
    if (retireOutgoing && outgoing.recipe_id) {
      const { error: retireErr } = await supabase
        .from("taproom_recipe_settings")
        .upsert(
          buildRetirePayload(outgoing.recipe_id, true, new Date().toISOString()),
          { onConflict: "recipe_id" },
        );
      if (retireErr) warning = `Swap queued, but retiring the outgoing beer failed: ${retireErr.message}`;
    }

    return NextResponse.json({ id: inserted.id, warning }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { data: row, error: loadErr } = await supabase
      .from("tap_swap_transitions")
      .select("id, from_recipe_id, retire_outgoing, consumed_source_ref")
      .eq("id", id)
      .maybeSingle();
    if (loadErr) return apiError(loadErr);
    if (!row) return NextResponse.json({ error: "Queued swap not found" }, { status: 404 });
    if (row.consumed_source_ref) {
      return NextResponse.json(
        { error: "This swap has already been rung and booked — it can't be cancelled." },
        { status: 409 },
      );
    }

    // Revert only what this swap changed.
    if (row.retire_outgoing && row.from_recipe_id) {
      const { error: unretireErr } = await supabase
        .from("taproom_recipe_settings")
        .upsert(
          buildRetirePayload(row.from_recipe_id as string, false, new Date().toISOString()),
          { onConflict: "recipe_id" },
        );
      if (unretireErr) return apiError(unretireErr);
    }

    const { error: delErr } = await supabase.from("tap_swap_transitions").delete().eq("id", id);
    if (delErr) return apiError(delErr);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
