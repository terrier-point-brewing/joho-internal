import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { recheckBatchCommitments } from "@/lib/production/commitmentFulfillment";
import { triggerSquarePush } from "@/lib/production/triggerSquarePush";

export const dynamic = "force-dynamic";

// Undo for floorplan moves and packaging runs. The restore itself — and every
// rule about when it is still safe — lives in undo_transfer_action
// (20261204090000_batch_transfer_actions_undo); this route only lists the
// candidates and relays the database's answer.

/** How far back the floorplan offers Undo. The guards, not this, decide safety. */
const LOOKBACK_DAYS = 7;
const MAX_LISTED = 8;

/** A refusal raised by undo_transfer_action — its message is written for the brewer. */
const REFUSAL_CODE = "P0001";

type ActionRow = { id: string; batch_id: string; transfer_type: string | null; summary: string | null; created_at: string };

export async function GET() {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  const { data, error } = await supabase
    .from("batch_transfer_actions")
    .select("id, batch_id, transfer_type, summary, created_at")
    .not("after_state", "is", null)
    .is("undone_at", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Only a batch's most recent action can be undone, so that is the only one
  // worth listing — the one before it becomes available once this one is undone.
  const seen = new Set<string>();
  const latestPerBatch = ((data ?? []) as ActionRow[]).filter((a) => {
    if (seen.has(a.batch_id)) return false;
    seen.add(a.batch_id);
    return true;
  }).slice(0, MAX_LISTED);

  const actions = await Promise.all(latestPerBatch.map(async (a) => {
    const { error: dryRunErr } = await supabase
      .rpc("undo_transfer_action", { p_action_id: a.id, p_dry_run: true });
    return {
      id: a.id,
      batch_id: a.batch_id,
      transfer_type: a.transfer_type,
      summary: a.summary,
      created_at: a.created_at,
      blocked_reason: dryRunErr ? dryRunErr.message : null,
    };
  }));

  return NextResponse.json(actions);
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { action_id } = (await req.json()) as { action_id?: string };
  if (!action_id) return NextResponse.json({ error: "action_id is required." }, { status: 400 });

  const { data, error } = await supabase
    .rpc("undo_transfer_action", { p_action_id: action_id, p_user_id: user?.id ?? null, p_dry_run: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.code === REFUSAL_CODE ? 409 : 500 });
  }

  const { batch_id, recipe_id } = data as { batch_id: string; recipe_id: string | null };
  const { data: action } = await supabase
    .from("batch_transfer_actions").select("transfer_type").eq("id", action_id).maybeSingle();
  const wasPackagingRun = action?.transfer_type === "kegging" || action?.transfer_type === "canning";

  // The undo is committed; these only bring derived state back in step, the
  // same best-effort tier as the transfer route's own follow-ups.
  try {
    await recheckBatchCommitments(supabase, batch_id);
  } catch (recheckErr) {
    console.error("[transfers/undo] Commitment recheck failed (undo committed):", recheckErr);
  }
  // Finished goods just left cold storage again — restate Square's counts.
  // No-ops while the push gate is shut; never throws.
  if (wasPackagingRun) await triggerSquarePush(supabase, [recipe_id], `undo transfer action ${action_id}`);

  return NextResponse.json({ ok: true, batch_id });
}
