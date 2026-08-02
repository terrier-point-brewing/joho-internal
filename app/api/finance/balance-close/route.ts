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
 *   { action: "refresh" | "skip" | "reopen" | "close-period" | "reopen-period", ... }
 *
 * Admin client, not the server client: balance_close_tasks' RLS is
 * lock-down-only (see 20260905100000_balance_sheet_snapshots.sql), so a
 * session-scoped client would silently see zero rows. Authorization is
 * enforced here via requirePermission, same as balance-sources.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP, getSessionUser } from "@/lib/auth";
import { monthEnd } from "@/lib/finance/manualEntries";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { todayLocalDate } from "@/lib/utils/datetime";
import {
  listTasksForPeriod,
  everyTaskAnswered,
  ensureTasksForPeriod,
  reconcileCloseTasks,
  resolveResponsibleEmails,
  skipTask,
  reopenTask,
  readCloseConfig,
  dueDateForPeriod,
  type CloseTask,
} from "@/lib/finance/balances/closeTasks";
import { closePeriod, reopenPeriod, readPeriodClose, readPeriodCoverage } from "@/lib/finance/balances/periodClose";

export const dynamic = "force-dynamic";
/** Closing runs a full recalculation, including live reads against Ramp, Plaid and Square. */
export const maxDuration = 60;

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
    const [close, coverage] = await Promise.all([
      readPeriodClose(supabase, periodEnd),
      readPeriodCoverage(supabase, periodEnd),
    ]);

    return NextResponse.json({
      periodEnd,
      tasks: await describeTasks(supabase, tasks, periodEnd),
      // Two different facts, deliberately named apart. `close` is whether a
      // PERSON has called this month final and who; `readyToClose` is whether
      // the checklist has anything left on it. The screen previously had only
      // the second and called it "closed", which is the conflation the whole
      // close workflow exists to undo.
      close,
      readyToClose: !(close?.closed ?? false) && everyTaskAnswered(tasks),
      // What closing would be asserting: how many configured accounts actually
      // produced a figure this month, and which ones did not.
      coverage,
      // The period's own deadline, which is not necessarily any one task's: an
      // account may carry its own allowance. Shown so the screen can say when
      // the period as a whole is expected to be done. Passing it no longer
      // freezes anything -- it means late, not finished.
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
 * Five write actions, all gated on financeTransactionsManage.
 *
 *   refresh       -- bring the checklist up to date on demand instead of
 *                    waiting for the nightly cron. Both halves are idempotent
 *                    by construction (see closeTasks.ts), so this is safe to
 *                    call on every page load and is what makes the screen
 *                    truthful the first time an account is configured rather
 *                    than the morning after.
 *   skip          -- "this account had no balance this month, and here is why".
 *   reopen        -- the inverse of a skip.
 *   close-period  -- a PERSON declares the month final. Recalculates, refuses
 *                    with reasons if anything is outstanding or the
 *                    recalculation did not finish cleanly, then freezes it with
 *                    their name on it.
 *   reopen-period -- the attributed inverse of that, reason required.
 *
 * The last two replace an unattributed `unfreeze` action. Reopening was
 * reachable while closing was not, so the only way a period ever became final
 * was the cron's due-date branch -- freezing was automatic and undoing it was
 * manual, which is exactly backwards.
 *
 * There is deliberately no "mark done" on a task and no "close anyway" on a
 * period. A task is completed only by reconcileCloseTasks, and only because the
 * balance row now exists; a period is closed only when nothing is outstanding.
 * Either override would let a month read as final with nothing behind it, which
 * is the one claim this workflow exists to make honestly.
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
      const reconciled = await reconcileCloseTasks(supabase, body.periodEnd);
      return NextResponse.json({ ok: true, created, ...reconciled });
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

    if (body.action !== "close-period" && body.action !== "reopen-period") {
      return NextResponse.json(
        { error: 'action must be "refresh", "skip", "reopen", "close-period" or "reopen-period"' },
        { status: 400 },
      );
    }
    if (!body.periodEnd || body.periodEnd !== monthEnd(body.periodEnd)) {
      return NextResponse.json({ error: "periodEnd is required and must be a month end" }, { status: 400 });
    }

    // Both period actions are attributed, so both need a real signed-in user.
    // requirePermission has already established there is one; this reads WHICH,
    // and refuses rather than recording a close by nobody — an unattributed
    // close is the thing being replaced, not a fallback for it.
    const session = await getSessionUser();
    if (!session) {
      return NextResponse.json({ error: "Sign in again before closing or reopening a month." }, { status: 401 });
    }

    const supabase = createSupabaseAdminClient();

    if (body.action === "close-period") {
      const result = await closePeriod(supabase, {
        periodEnd: body.periodEnd,
        actorId: session.user.id,
        todayIso: todayLocalDate(),
      });
      // 409, not 400: the request was well formed and the answer is about the
      // state of the books. The blockers are full sentences meant to be shown
      // as they are.
      return result.ok
        ? NextResponse.json({ ok: true, close: result.state, snapshot: result.snapshot })
        : NextResponse.json({ error: result.blockers.join(" "), blockers: result.blockers }, { status: 409 });
    }

    if (typeof body.reason !== "string" || body.reason.trim() === "") {
      return NextResponse.json({ error: "Say why this month is being reopened." }, { status: 400 });
    }
    const reopened = await reopenPeriod(supabase, {
      periodEnd: body.periodEnd,
      actorId: session.user.id,
      reason: body.reason,
    });
    return reopened
      ? NextResponse.json({ ok: true, close: reopened })
      : NextResponse.json({ error: "That month is not currently closed." }, { status: 409 });
  } catch (err) {
    return apiError(err);
  }
}
