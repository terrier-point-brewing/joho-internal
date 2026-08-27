/**
 * The GL allocation of one bank line: replace the whole set, or clear it.
 *
 * Why only a `balance_sheet_movement` row can have one, and why the lines must
 * balance to the parent to the cent, are both argued in
 * lib/finance/bankLedgerSplits.ts. Both are re-checked here: the editor keeps
 * Save disabled until they hold, and a client that skipped the editor is not
 * taken at its word.
 *
 * Writing a split pins `mapping_source = 'manual'`, which is what stops
 * resolveBankBackfill (autoMap.ts) re-coding a parent whose real coding now
 * lives in its split lines.
 *
 * Manager+ only, service-role client.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { validateBankSplit, resolveBankGlLines, type BankSplitLine } from "@/lib/finance/bankLedgerSplits";

export const dynamic = "force-dynamic";

interface SplitLineBody {
  chart_of_accounts_id: string;
  amount_cents:         number;
  memo?:                string | null;
}

type SbClient = ReturnType<typeof createSupabaseAdminClient>;

/** Re-read the line's effective GL lines so the grid can update the row without a reload. */
async function currentState(sb: SbClient, id: string) {
  const { data: splitRows, error: splitErr } = await sb
    .from("bank_ledger_gl_splits")
    .select("chart_of_accounts_id, amount_cents, memo")
    .eq("bank_ledger_id", id)
    .order("created_at", { ascending: true });
  if (splitErr) throw new Error(splitErr.message);

  const { data: row, error: rowErr } = await sb
    .from("bank_ledger").select("chart_of_accounts_id, amount_cents, mapping_source").eq("id", id).single();
  if (rowErr) throw new Error(rowErr.message);

  const splits: BankSplitLine[] = (splitRows ?? []).map((r) => ({
    chartOfAccountsId: r.chart_of_accounts_id as string,
    amountCents:       r.amount_cents as number,
    memo:              (r.memo as string | null) ?? null,
  }));

  return {
    glLines: resolveBankGlLines(splits, {
      chartOfAccountsId: (row?.chart_of_accounts_id as string | null) ?? null,
      amountCents:       (row?.amount_cents as number) ?? 0,
    }),
    // Whether the row is CARRYING a split, which the grid needs to tell "one
    // account, shown as one line" from "one account, because that is the whole
    // allocation". resolveBankGlLines cannot answer it: both look identical.
    isSplit:        splits.length > 0,
    mapping_source: row?.mapping_source as string,
  };
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const { id } = await params;
  const body = (await req.json()) as { lines?: SplitLineBody[] };
  const lines = body.lines ?? [];

  const sb = createSupabaseAdminClient();

  const { data: row, error: rowErr } = await sb
    .from("bank_ledger").select("id, amount_cents, flow_type").eq("id", id).single();
  if (rowErr) return NextResponse.json({ error: rowErr.message }, { status: 500 });

  const validation = validateBankSplit(
    lines.map((l) => ({ chartOfAccountsId: l.chart_of_accounts_id, amountCents: l.amount_cents, memo: l.memo ?? null })),
    row?.amount_cents as number,
    row?.flow_type as string | null,
  );
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

  const coaIds = Array.from(new Set(lines.map((l) => l.chart_of_accounts_id)));
  const { data: coaRows, error: coaErr } = await sb.from("chart_of_accounts").select("id").in("id", coaIds);
  if (coaErr) return NextResponse.json({ error: coaErr.message }, { status: 500 });
  if ((coaRows ?? []).length !== coaIds.length) {
    return NextResponse.json({ error: "One or more GL accounts do not exist" }, { status: 400 });
  }

  // PostgREST has no transaction across two calls, so capture what is about to
  // be replaced: if the insert fails, put it back rather than leaving the
  // operator with no allocation at all. Validation and account existence are
  // settled above, so a failure here is transient -- which is exactly when
  // silently destroying somebody's work is least excusable.
  const { data: priorRows, error: priorErr } = await sb
    .from("bank_ledger_gl_splits")
    .select("bank_ledger_id, chart_of_accounts_id, amount_cents, memo")
    .eq("bank_ledger_id", id);
  if (priorErr) return NextResponse.json({ error: priorErr.message }, { status: 500 });

  const { error: delErr } = await sb.from("bank_ledger_gl_splits").delete().eq("bank_ledger_id", id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  const { error: insErr } = await sb.from("bank_ledger_gl_splits").insert(
    lines.map((l) => ({
      bank_ledger_id:       id,
      chart_of_accounts_id: l.chart_of_accounts_id,
      amount_cents:         l.amount_cents,
      memo:                 l.memo ?? null,
    })),
  );
  if (insErr) {
    if ((priorRows ?? []).length > 0) await sb.from("bank_ledger_gl_splits").insert(priorRows!);
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  // The parent's own account is CLEARED, not merely outranked.
  //
  // This is the one place this route parts company with the expense split, and
  // the reason is that the two readers disagree in a way that matters. The P&L
  // knows the precedence rule (`splitLines?.length ? splitLines : own`), so a
  // split expense may safely keep its account. The balance sheet's bank sum
  // matches on `chart_of_accounts_id` alone; sumBank now excludes split parents,
  // but a value nothing reads is a trap for the next reader written against this
  // table -- and the account is no longer TRUE either way. The allocation is the
  // coding now.
  const { error: pinErr } = await sb
    .from("bank_ledger")
    .update({ chart_of_accounts_id: null, mapping_source: "manual" })
    .eq("id", id);
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

  const { error: delErr } = await sb.from("bank_ledger_gl_splits").delete().eq("bank_ledger_id", id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  // `mapping_source` is deliberately left as 'manual'. On an expense the same
  // moment unpins the row so a rule can re-code it, but this row's FLOW was
  // classified by a person -- clearing splits says nothing about that decision,
  // and un-protecting it here would let the next counterparty-rule pass write an
  // account onto a line somebody had already answered. The row is now coded to
  // nothing and shows its account picker again, which is the honest state:
  // clearing an allocation leaves the money unallocated.
  try {
    return NextResponse.json(await currentState(sb, id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
