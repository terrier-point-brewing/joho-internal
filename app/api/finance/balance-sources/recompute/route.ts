/**
 * POST /api/finance/balance-sources/recompute   { periodEnd? }
 *   Recomputes and stores every account's balance for a month that has ENDED.
 *   Defaults to the most recently ended month -- the same one the nightly cron
 *   works on.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Configuring an account used to have no visible effect until 09:00 the next
 * morning. Three accounts were set up at 8pm on 1 August and the balance sheet
 * showed exactly what it had before, with nothing on any screen saying the
 * figures predated the change. "Did that work?" was unanswerable for thirteen
 * hours.
 *
 * ── It runs the cron's own function, not a copy ──────────────────────────────
 * `snapshotPeriod` is what balance-close calls. A button with its own lighter
 * recompute could produce a different number from the one the close will
 * freeze, which is the single worst outcome available here.
 *
 * ── It cannot touch a frozen period, and cannot invent one ───────────────────
 * Frozen rows are skipped by resolveSnapshotWrites, so a closed month is safe
 * by construction. The open month is refused OUTRIGHT rather than skipped:
 * gl_account_balances rows are dated to a month end, and writing a part-way
 * August figure under 2026-08-31 would put a mid-month number where every
 * reader expects a closing balance. The open month is live-computed on demand
 * instead -- see lib/finance/balances/liveBalances.ts -- so there is nothing to
 * store and nothing to wait for.
 *
 * ── Backfilling older months ─────────────────────────────────────────────────
 * Passing an older `periodEnd` fills in a month that was never snapshotted --
 * only the most recently ended one ever has been, so anything before 2026-06 is
 * blank. That is the same operation, not a special mode, and needs no separate
 * route or flag.
 *
 * `snapshotPeriod` recognises an older month itself and leaves out any account
 * whose calculation can only answer about today. Exactly one does: GL 1100 A/R,
 * whose `openInvoiceAr` step sums invoices open NOW. Asked about March it would
 * return the March invoices still unpaid today -- a real number, plainly
 * formatted, and not March's receivables. The account is reported as excluded
 * and left with no row, so it reads as unsourced for that month, which is the
 * "null, not zero" rule applied to a figure genuinely not recoverable from what
 * is stored. `invoices` carries no payment date to reconstruct one from;
 * changing that is its own piece of work, not a flag here.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
// Side-effect import: registers every provider and method so the snapshot has
// something to resolve against, exactly as the cron route does.
import "@/lib/finance/balances/methods";
import { snapshotPeriod } from "@/lib/finance/balances/snapshot";
import { mostRecentlyEndedMonthEnd } from "@/lib/finance/balances/periods";
import { monthEnd } from "@/lib/finance/manualEntries";
import { todayLocalDate } from "@/lib/utils/datetime";

export const dynamic = "force-dynamic";
/** Runs every active source, including live reads against Ramp and Square. */
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Manage, not read: this writes gl_account_balances.
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const body = (await req.json().catch(() => ({}))) as { periodEnd?: string };
    const today = todayLocalDate();
    const periodEnd = body.periodEnd?.trim() || mostRecentlyEndedMonthEnd(today);

    if (periodEnd !== monthEnd(periodEnd)) {
      return NextResponse.json({ error: "periodEnd must be a month end." }, { status: 400 });
    }
    if (periodEnd > today) {
      return NextResponse.json(
        {
          error:
            "That month has not ended yet. Its balances are worked out fresh every time the balance sheet is opened, so there is nothing to recompute.",
        },
        { status: 400 },
      );
    }

    const supabase = createSupabaseAdminClient();
    const result = await snapshotPeriod(supabase, periodEnd, { todayIso: today });

    // Errors come back in the body rather than as a failed request: some
    // accounts having succeeded is the normal partial outcome, and the operator
    // needs to see which ones did not. `excluded` is separate from `errors` on
    // purpose -- an account left out of a backfill is a decision, not a fault,
    // and reporting the two together would train somebody to ignore both.
    return NextResponse.json({
      periodEnd,
      ...result,
      excluded: await describeExcluded(supabase, result.excluded),
    });
  } catch (err) {
    return apiError(err);
  }
}

/** Turns excluded account ids into "1100 · Accounts Receivable" for the notice line. */
async function describeExcluded(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  coaIds: string[],
): Promise<string[]> {
  if (coaIds.length === 0) return [];
  const { data } = await supabase
    .from("chart_of_accounts")
    .select("id, account_name, account_number")
    .in("id", coaIds);
  const byId = new Map(
    ((data ?? []) as { id: string; account_name: string; account_number: string | null }[]).map((r) => [
      r.id,
      r.account_number ? `${r.account_number} · ${r.account_name}` : r.account_name,
    ]),
  );
  return coaIds.map((id) => byId.get(id) ?? id);
}
