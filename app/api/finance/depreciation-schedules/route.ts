/**
 * Depreciation schedules: the standing rules for which fixed-asset accounts
 * depreciate, over what life, expensed where. Read by the Settings panel;
 * consumed by the derived P&L rows, GL 1590's provider and retained earnings
 * through lib/finance/depreciation.
 *
 * ── Life edits are PROSPECTIVE revisions, never rewrites ─────────────────────
 * PATCHing a new life inserts a revision effective the current month: months
 * already reported keep the charge they reported, and the remaining book value
 * spreads over the remaining new life from now on — ASC 250's change-in-
 * estimate treatment. Editing the life twice in one month replaces that
 * month's revision rather than stacking two, which is still prospective (the
 * month is open) and keeps one answer per month. There is deliberately no
 * endpoint that recomputes history under a new life: that is error-correction
 * territory, and a route for it would be a button that silently rewrites every
 * closed month's P&L.
 *
 * ── Delete is for mistakes, End is for assets ────────────────────────────────
 * DELETE removes a schedule created THIS month — a slip caught before any
 * closed month could have included its charges. Anything older must be ENDED
 * instead (ended_month = this month): the charges it accrued stay on every
 * statement, held constant, because deleting them would silently restate
 * history the same way a life rewrite would.
 *
 * Manager+ only, service-role client.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchCoa } from "@/lib/finance/financials/fetchSources";
import { fetchDepreciationState, seriesFor } from "@/lib/finance/depreciation/state";

export const dynamic = "force-dynamic";

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function GET() {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  const supabase = createSupabaseAdminClient();

  const coa = await fetchCoa(supabase);
  const states = await fetchDepreciationState(supabase, coa);
  const month = currentMonth();

  return NextResponse.json(
    states.map((s) => {
      const series = seriesFor(s, month);
      const basisCents = s.additions.reduce((sum, a) => sum + a.cents, 0);
      const currentLife = s.revisions.reduce<number | null>(
        (life, r) => (r.effectiveMonth === null || r.effectiveMonth <= month ? r.lifeMonths : life),
        null,
      );
      return {
        id: s.id,
        asset_chart_of_accounts_id: s.assetChartOfAccountsId,
        expense_chart_of_accounts_id: s.expenseChartOfAccountsId,
        contra_chart_of_accounts_id: s.contraChartOfAccountsId,
        ended_month: s.endedMonth,
        life_months: currentLife,
        revisions: s.revisions,
        // The figures a person needs to sanity-check the rule they just made.
        basis_cents: basisCents,
        accumulated_cents: series.accumulatedCents,
        current_month_expense_cents: series.expenseCentsByMonth[month] ?? 0,
        first_addition_month: s.additions[0]?.month ?? null,
      };
    }),
  );
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  const body = (await req.json()) as {
    asset_chart_of_accounts_id?: string;
    expense_chart_of_accounts_id?: string;
    contra_chart_of_accounts_id?: string;
    life_months?: number;
  };
  const { asset_chart_of_accounts_id: asset, expense_chart_of_accounts_id: expense, contra_chart_of_accounts_id: contra } = body;
  const life = body.life_months;
  if (!asset || !expense || !contra) return NextResponse.json({ error: "asset, expense and contra accounts are all required" }, { status: 400 });
  if (!Number.isInteger(life) || life! <= 0) return NextResponse.json({ error: "life_months must be a positive whole number" }, { status: 400 });
  if (new Set([asset, expense, contra]).size !== 3) {
    return NextResponse.json({ error: "The asset, expense and accumulated-depreciation accounts must be three different accounts" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const { data: coaRows, error: coaErr } = await supabase.from("chart_of_accounts").select("id").in("id", [asset, expense, contra]);
  if (coaErr) return NextResponse.json({ error: coaErr.message }, { status: 500 });
  if ((coaRows ?? []).length !== 3) return NextResponse.json({ error: "One or more accounts do not exist" }, { status: 400 });

  const { data: schedule, error } = await supabase
    .from("depreciation_schedules")
    .insert({ asset_chart_of_accounts_id: asset, expense_chart_of_accounts_id: expense, contra_chart_of_accounts_id: contra })
    .select("id")
    .single();
  if (error) {
    const status = error.message.includes("depreciation_schedules_asset_chart_of_accounts_id_key") ? 409 : 500;
    return NextResponse.json(
      { error: status === 409 ? "That account already has a depreciation schedule" : error.message },
      { status },
    );
  }

  // The inception life: in force from the first addition onward. If this
  // insert fails the schedule is removed rather than left lifeless — a
  // schedule with no revision depreciates nothing, silently.
  const { error: revErr } = await supabase
    .from("depreciation_life_revisions")
    .insert({ schedule_id: schedule!.id, effective_month: null, life_months: life });
  if (revErr) {
    await supabase.from("depreciation_schedules").delete().eq("id", schedule!.id);
    return NextResponse.json({ error: revErr.message }, { status: 500 });
  }

  return NextResponse.json({ id: schedule!.id });
}

export async function PATCH(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  const body = (await req.json()) as {
    id?: string;
    life_months?: number;
    ended?: boolean;
    expense_chart_of_accounts_id?: string;
  };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = createSupabaseAdminClient();
  const { data: schedule, error: loadErr } = await supabase
    .from("depreciation_schedules").select("id, ended_month").eq("id", body.id).single();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!schedule) return NextResponse.json({ error: "No such schedule" }, { status: 404 });

  const month = currentMonth();

  if (body.life_months !== undefined) {
    if (!Number.isInteger(body.life_months) || body.life_months <= 0) {
      return NextResponse.json({ error: "life_months must be a positive whole number" }, { status: 400 });
    }
    // Prospective: a revision effective this month. Re-editing within the same
    // month replaces this month's answer instead of stacking revisions.
    // Select-then-write rather than upsert: the uniqueness lives in a PARTIAL
    // index (effective_month is not null), which PostgREST's on_conflict
    // cannot name — the same limitation upsert_bank_ledger_gl_rule works
    // around in SQL. Two racing saves of the same month collapse to one row
    // either way, the second losing only its own duplicate insert.
    const { data: existing, error: exErr } = await supabase
      .from("depreciation_life_revisions")
      .select("id").eq("schedule_id", body.id).eq("effective_month", `${month}-01`).maybeSingle();
    if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 });
    const { error } = existing
      ? await supabase.from("depreciation_life_revisions").update({ life_months: body.life_months }).eq("id", existing.id)
      : await supabase.from("depreciation_life_revisions").insert({ schedule_id: body.id, effective_month: `${month}-01`, life_months: body.life_months });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (typeof body.ended === "boolean") {
    const { error } = await supabase
      .from("depreciation_schedules")
      .update({ ended_month: body.ended ? `${month}-01` : null })
      .eq("id", body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Moving the expense account re-presents every derived row under the new
  // account — a reclassification within the P&L, not an estimate change, and
  // the operator asked for it. The asset account is deliberately NOT editable:
  // pointing history's charges at a different asset's additions is a different
  // schedule, not an edit to this one.
  if (body.expense_chart_of_accounts_id) {
    const { data: coaRow, error: coaErr } = await supabase
      .from("chart_of_accounts").select("id").eq("id", body.expense_chart_of_accounts_id).maybeSingle();
    if (coaErr) return NextResponse.json({ error: coaErr.message }, { status: 500 });
    if (!coaRow) return NextResponse.json({ error: "No such account" }, { status: 400 });
    const { error } = await supabase
      .from("depreciation_schedules")
      .update({ expense_chart_of_accounts_id: body.expense_chart_of_accounts_id })
      .eq("id", body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  const { id } = (await req.json()) as { id?: string };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = createSupabaseAdminClient();
  const { data: schedule, error: loadErr } = await supabase
    .from("depreciation_schedules").select("id, created_at").eq("id", id).single();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!schedule) return NextResponse.json({ error: "No such schedule" }, { status: 404 });

  if ((schedule.created_at as string).slice(0, 7) !== currentMonth()) {
    return NextResponse.json(
      { error: "This schedule has been charging for past months, so deleting it would silently restate them. End it instead — its charges stop, and what it already accrued stays put." },
      { status: 409 },
    );
  }

  const { error } = await supabase.from("depreciation_schedules").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
