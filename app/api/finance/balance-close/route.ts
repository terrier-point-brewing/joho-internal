/**
 * GET /api/finance/balance-close?periodEnd=YYYY-MM-DD
 *   The period's balance_close_tasks, enriched with everything needed to
 *   actually DO them: which account, who is on the hook, by when, what the
 *   account read last month, and what has been entered for this one.
 *
 *   The bare task list was enough for a banner that counts things and enough
 *   for nothing else. Somebody arriving from the alert email is looking at an
 *   account number and being asked for a figure, and the two questions they
 *   have -- "which account is this?" and "what did it say last month?" -- were
 *   both answerable only by leaving the screen.
 *
 * POST /api/finance/balance-close
 *   { action: "refresh" | "skip" | "reopen" | "unfreeze", ... }
 *
 * Admin client, not the server client: balance_close_tasks' RLS is
 * lock-down-only (see 20260905100000_balance_sheet_snapshots.sql), so a
 * session-scoped client would silently see zero rows. Authorization is
 * enforced here via requirePermission, same as balance-sources.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { unfreezePeriod } from "@/lib/finance/balances/snapshot";
import { monthEnd } from "@/lib/finance/manualEntries";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  listTasksForPeriod,
  isPeriodClosed,
  ensureTasksForPeriod,
  reconcileCloseTasks,
  resolveResponsibleEmails,
  skipTask,
  reopenTask,
  readCloseConfig,
  dueDateForPeriod,
  type CloseTask,
} from "@/lib/finance/balances/closeTasks";

export const dynamic = "force-dynamic";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** One outstanding (or settled) account, as the close panel needs to render it. */
interface CloseTaskDetail extends CloseTask {
  accountName: string;
  accountNumber: string | null;
  /** Who is chased for this one. Null when nobody has been named in Settings. */
  responsibleEmail: string | null;
  /** The balance already recorded for THIS period, once one exists. */
  enteredCents: number | null;
  /** The last balance recorded BEFORE this period — the figure to sanity-check against. */
  previousBalance: { asOfDate: string; cents: number } | null;
}

/**
 * Attaches the account, the person and the surrounding balances to each task.
 *
 * All three lookups are batched across the whole period rather than done per
 * task: this list is short, but it is rendered on a screen someone reaches from
 * an email, and a per-row fetch is how that screen would come to take a second
 * to paint for six accounts.
 */
async function describeTasks(supabase: AdminClient, tasks: CloseTask[], periodEnd: string): Promise<CloseTaskDetail[]> {
  if (tasks.length === 0) return [];
  const coaIds = Array.from(new Set(tasks.map((t) => t.coaId)));

  const [coaRes, entriesRes, responsibleEmails] = await Promise.all([
    supabase.from("chart_of_accounts").select("id, account_name, account_number").in("id", coaIds),
    // Everything up to and including this period end, newest first. One query
    // answers both "what was entered for this month" and "what did it read
    // last time", and the ordering is what makes the second one a first-hit.
    supabase
      .from("manual_entries")
      .select("chart_of_accounts_id, as_of_date, amount_cents")
      .eq("entry_kind", "balance")
      .in("chart_of_accounts_id", coaIds)
      .lte("as_of_date", periodEnd)
      .order("as_of_date", { ascending: false }),
    resolveResponsibleEmails(supabase, coaIds),
  ]);
  if (coaRes.error) throw new Error(coaRes.error.message);
  if (entriesRes.error) throw new Error(entriesRes.error.message);

  const coaById = new Map(
    ((coaRes.data ?? []) as { id: string; account_name: string; account_number: string | null }[]).map((r) => [r.id, r]),
  );

  const entered = new Map<string, number>();
  const previous = new Map<string, { asOfDate: string; cents: number }>();
  for (const row of (entriesRes.data ?? []) as {
    chart_of_accounts_id: string;
    as_of_date: string;
    amount_cents: number;
  }[]) {
    if (row.as_of_date === periodEnd) entered.set(row.chart_of_accounts_id, row.amount_cents);
    else if (!previous.has(row.chart_of_accounts_id)) {
      previous.set(row.chart_of_accounts_id, { asOfDate: row.as_of_date, cents: row.amount_cents });
    }
  }

  return tasks.map((task) => ({
    ...task,
    accountName: coaById.get(task.coaId)?.account_name ?? "Unknown account",
    accountNumber: coaById.get(task.coaId)?.account_number ?? null,
    responsibleEmail: responsibleEmails.get(task.coaId) ?? null,
    enteredCents: entered.get(task.coaId) ?? null,
    previousBalance: previous.get(task.coaId) ?? null,
  }));
}

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  try {
    const periodEnd = req.nextUrl.searchParams.get("periodEnd");
    if (!periodEnd) {
      return NextResponse.json({ error: "periodEnd is required" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const tasks = await listTasksForPeriod(supabase, periodEnd);
    const { dueDay } = await readCloseConfig(supabase);

    return NextResponse.json({
      periodEnd,
      tasks: await describeTasks(supabase, tasks, periodEnd),
      closed: isPeriodClosed(tasks),
      // The period's own deadline, which is not necessarily any one task's: an
      // account may carry its own allowance. Shown so the screen can say when
      // the period as a whole is expected to be done.
      dueDate: dueDateForPeriod(periodEnd, dueDay),
    });
  } catch (err) {
    return apiError(err);
  }
}

interface PostBody {
  action?: string;
  periodEnd?: string;
  taskId?: string;
  reason?: string;
}

/**
 * Four write actions, all gated on financeTransactionsManage.
 *
 *   refresh  -- bring the checklist up to date on demand instead of waiting for
 *               the nightly cron. Both halves are idempotent by construction
 *               (see closeTasks.ts), so this is safe to call on every page load
 *               and is what makes the screen truthful the first time an account
 *               is configured rather than the morning after.
 *   skip     -- "this account had no balance this month, and here is why".
 *   reopen   -- the inverse of a skip.
 *   unfreeze -- reopen a frozen PERIOD so its balances recompute.
 *
 * There is deliberately no "mark done": a task is completed only by
 * reconcileCloseTasks, and only because the balance row now exists. A button
 * that set the status directly would let a period read as closed with nothing
 * behind it, which is the one claim this checklist exists to make honestly.
 */
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as PostBody;

    if (body.action === "refresh") {
      if (!body.periodEnd || body.periodEnd !== monthEnd(body.periodEnd)) {
        return NextResponse.json({ error: "periodEnd is required and must be a month end" }, { status: 400 });
      }
      const supabase = createSupabaseAdminClient();
      const created = await ensureTasksForPeriod(supabase, body.periodEnd);
      const closed = await reconcileCloseTasks(supabase, body.periodEnd);
      return NextResponse.json({ ok: true, created, closed });
    }

    if (body.action === "skip" || body.action === "reopen") {
      if (typeof body.taskId !== "string" || body.taskId.trim() === "") {
        return NextResponse.json({ error: "taskId is required" }, { status: 400 });
      }
      const supabase = createSupabaseAdminClient();

      if (body.action === "reopen") {
        const done = await reopenTask(supabase, body.taskId);
        return done
          ? NextResponse.json({ ok: true })
          : NextResponse.json({ error: "That account is not currently skipped." }, { status: 409 });
      }

      // The reason is the whole point of a skip, so it is required here rather
      // than defaulted to something bland. skipTask refuses a blank one too;
      // this check exists to answer with a sentence instead of a 500.
      if (typeof body.reason !== "string" || body.reason.trim() === "") {
        return NextResponse.json({ error: "Say why this account has no balance this month." }, { status: 400 });
      }
      const done = await skipTask(supabase, body.taskId, body.reason);
      return done
        ? NextResponse.json({ ok: true })
        : NextResponse.json(
            { error: "That account is no longer outstanding — it may already have a balance." },
            { status: 409 },
          );
    }

    /**
     * Reopen a frozen period so its balances recompute on the next snapshot run.
     *
     * The cron freezes unconditionally once the due date passes, whether or not
     * the period's tasks were ever fulfilled. Without a reachable inverse, a
     * late Ramp bill or a corrected invoice for a closed month is
     * unrepresentable except by direct database access — and a period frozen in
     * error stays wrong forever, since resolveSnapshotWrites skips frozen rows
     * on every subsequent pass. `unfreezePeriod` existed but had no caller;
     * this is that caller.
     */
    if (body.action !== "unfreeze") {
      return NextResponse.json({ error: 'action must be "refresh", "skip", "reopen" or "unfreeze"' }, { status: 400 });
    }
    if (!body.periodEnd || body.periodEnd !== monthEnd(body.periodEnd)) {
      return NextResponse.json({ error: "periodEnd is required and must be a month end" }, { status: 400 });
    }
    await unfreezePeriod(createSupabaseAdminClient(), body.periodEnd);
    return NextResponse.json({ ok: true, periodEnd: body.periodEnd });
  } catch (err) {
    return apiError(err);
  }
}
