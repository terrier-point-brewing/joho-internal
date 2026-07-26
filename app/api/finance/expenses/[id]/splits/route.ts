/**
 * Manual GL splits for one expense: replace the whole manual set, or clear it.
 *
 * Only ever touches split_source='manual' rows -- payroll_auto rows belong to
 * the pay-period recompute and are never written here. Writing a manual split
 * also pins the parent's mapping_source to 'manual', which is what stops both
 * resolveExpenseMapping (rampExpenses.ts) and autoMap's bulk update from
 * re-coding a parent whose real coding now lives in its split lines.
 *
 * Manager+ only, service-role client.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { validateManualSplit } from "@/lib/finance/expenseSplits";
import { resolveExpenseGlLines } from "@/lib/finance/expenseGlLines";

export const dynamic = "force-dynamic";

interface SplitLineBody {
  chart_of_accounts_id: string;
  amount_cents:         number;
  memo?:                string | null;
}

type SbClient = ReturnType<typeof createSupabaseAdminClient>;

/** Re-read the expense's effective GL lines so the client can update the row without a reload. */
async function currentState(sb: SbClient, id: string) {
  const { data: splitRows, error: splitErr } = await sb
    .from("expense_gl_splits")
    .select("chart_of_accounts_id, amount_cents, split_source, memo")
    .eq("expense_id", id)
    .order("created_at", { ascending: true });
  if (splitErr) throw new Error(splitErr.message);

  const { data: expense, error: expErr } = await sb
    .from("expenses").select("chart_of_accounts_id, amount_cents, mapping_source").eq("id", id).single();
  if (expErr) throw new Error(expErr.message);

  const splits = (splitRows ?? []).map((r) => ({
    chartOfAccountsId: r.chart_of_accounts_id as string,
    amountCents:       r.amount_cents as number,
    splitSource:       r.split_source as "payroll_auto" | "manual",
    memo:              (r.memo as string | null) ?? null,
  }));

  return {
    glLines: resolveExpenseGlLines(splits, {
      chartOfAccountsId: (expense?.chart_of_accounts_id as string | null) ?? null,
      amountCents:       (expense?.amount_cents as number) ?? 0,
    }),
    mapping_source: expense?.mapping_source as string,
  };
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const { id } = await params;
  const body = (await req.json()) as { lines?: SplitLineBody[] };
  const lines = body.lines ?? [];

  const sb = createSupabaseAdminClient();

  const { data: expense, error: expErr } = await sb
    .from("expenses").select("id, amount_cents, excluded_at").eq("id", id).single();
  if (expErr) return NextResponse.json({ error: expErr.message }, { status: 500 });
  if (expense?.excluded_at) {
    return NextResponse.json({ error: "Restore this transaction before splitting it" }, { status: 409 });
  }

  // A payroll-matched expense is already fully coded by its pay-period splits.
  // Manual lines are inserted ALONGSIDE those rows, and the P&L replaces the
  // parent with every split it finds regardless of split_source
  // (aggregateRows.ts:305-312) -- so allowing both would book the expense
  // twice. That is precisely the double-count this feature exists to remove,
  // and validateManualSplit cannot catch it: the manual lines balance against
  // the parent on their own. Unmatch the pay period first.
  const { data: autoRows, error: autoErr } = await sb
    .from("expense_gl_splits").select("id").eq("expense_id", id).eq("split_source", "payroll_auto").limit(1);
  if (autoErr) return NextResponse.json({ error: autoErr.message }, { status: 500 });
  if ((autoRows ?? []).length > 0) {
    return NextResponse.json(
      { error: "This expense is coded by its pay period; unmatch it before splitting manually" },
      { status: 409 },
    );
  }

  const validation = validateManualSplit(
    lines.map((l) => ({ chartOfAccountsId: l.chart_of_accounts_id, amountCents: l.amount_cents, memo: l.memo ?? null })),
    expense?.amount_cents as number,
  );
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

  const coaIds = Array.from(new Set(lines.map((l) => l.chart_of_accounts_id)));
  const { data: coaRows, error: coaErr } = await sb.from("chart_of_accounts").select("id").in("id", coaIds);
  if (coaErr) return NextResponse.json({ error: coaErr.message }, { status: 500 });
  if ((coaRows ?? []).length !== coaIds.length) {
    return NextResponse.json({ error: "One or more GL accounts do not exist" }, { status: 400 });
  }

  // PostgREST has no transaction across two calls, so capture the rows we are
  // about to replace: if the insert fails, put them back rather than leaving the
  // operator with no split at all. Validation and CoA existence are checked
  // above, so a failure here is transient (connection/constraint), not user
  // error -- which is exactly the case where silently destroying their work is
  // least excusable.
  const { data: priorRows, error: priorErr } = await sb
    .from("expense_gl_splits")
    .select("expense_id, chart_of_accounts_id, amount_cents, split_source, memo")
    .eq("expense_id", id)
    .eq("split_source", "manual");
  if (priorErr) return NextResponse.json({ error: priorErr.message }, { status: 500 });

  const { error: delErr } = await sb
    .from("expense_gl_splits").delete().eq("expense_id", id).eq("split_source", "manual");
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  const { error: insErr } = await sb.from("expense_gl_splits").insert(
    lines.map((l) => ({
      expense_id:           id,
      chart_of_accounts_id: l.chart_of_accounts_id,
      amount_cents:         l.amount_cents,
      split_source:         "manual" as const,
      memo:                 l.memo ?? null,
    })),
  );
  if (insErr) {
    if ((priorRows ?? []).length > 0) await sb.from("expense_gl_splits").insert(priorRows!);
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  const { error: pinErr } = await sb.from("expenses").update({ mapping_source: "manual" }).eq("id", id);
  if (pinErr) return NextResponse.json({ error: pinErr.message }, { status: 500 });

  try {
    return NextResponse.json(await currentState(sb, id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const { id } = await params;
  const sb = createSupabaseAdminClient();

  const { data: cleared, error: delErr } = await sb
    .from("expense_gl_splits").delete().eq("expense_id", id).eq("split_source", "manual").select("id");
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  // Unpin so the next sync / auto-map re-resolves this expense by rule, but ONLY
  // if a manual split actually existed. mapping_source === 'manual' also means
  // "operator pinned a GL account by hand", which has nothing to do with splits
  // -- clobbering that here would silently un-protect the row from
  // resolveExpenseMapping and autoMap on the next sync.
  // chart_of_accounts_id is left as-is; resolveExpenseMapping re-derives it.
  if ((cleared ?? []).length > 0) {
    const { error: unpinErr } = await sb.from("expenses").update({ mapping_source: "unmapped" }).eq("id", id);
    if (unpinErr) return NextResponse.json({ error: unpinErr.message }, { status: 500 });
  }

  try {
    return NextResponse.json(await currentState(sb, id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
