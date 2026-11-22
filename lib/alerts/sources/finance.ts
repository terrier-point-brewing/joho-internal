/**
 * Finance alerts: the month-end close, tax filings, the integrations the
 * balance sheet reads from. Each reads what its screen reads.
 */
import "@/lib/tax/parties";
import { CAP } from "@/lib/auth/capabilities";
import {
  dueDateForPeriod,
  everyTaskAnswered,
  listTasksForPeriod,
  readCloseConfig,
} from "@/lib/finance/balances/closeTasks";
import { listConnections } from "@/lib/finance/balances/connections";
import { formatPeriodLabel, mostRecentlyEndedMonthEnd } from "@/lib/finance/balances/periods";
import { listDuplicateReview } from "@/lib/finance/duplicateReview";
import { getParty } from "@/lib/tax/registry";
import { listSchedules } from "@/lib/tax/schedules";
import { taskDueStatus } from "@/lib/tax/taskDueStatus";
import { listTasks } from "@/lib/tax/tasks";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AlertItem, AlertSource } from "../types";
import {
  duplicatesByBlockedPeriod,
  recalculationTrouble,
  unclosedPeriodEnds,
  type CloseEvent,
  type RecalculationRun,
} from "./closeReadiness";
import { plural } from "./helpers";

// ── Month-end close ──────────────────────────────────────────────────────────
// Everything the Close button would refuse on, for every month still open: an
// account missing its balance, a possible duplicate nobody has answered, and a
// nightly recalculation that keeps failing. Then the month itself, once nothing
// is left but pressing Close. See closeReadiness.ts for why all three and why
// every open month.

/** How many nightly runs the recalculation check looks back over. */
const RECALCULATION_WINDOW = 7;

interface BalanceCloseRunRow {
  status: string;
  error: string | null;
  detail: { periodEnd?: string; snapshot?: { errors?: string[] } } | null;
}

/** The latest ended month's recent nightly runs, newest first. */
async function recentRecalculations(admin: SupabaseClient, periodEnd: string): Promise<RecalculationRun[]> {
  const { data, error } = await admin
    .from("cron_runs")
    .select("status, error, detail")
    .eq("job", "balance-close")
    // A run for this month can only have started after the month ended, which
    // is what keeps a crashed run (no detail, so no periodEnd) to this month.
    .gt("started_at", `${periodEnd}T23:59:59Z`)
    .order("started_at", { ascending: false })
    .limit(RECALCULATION_WINDOW);
  if (error) throw new Error(error.message);

  return ((data ?? []) as BalanceCloseRunRow[])
    .filter((r) => r.status !== "success" || r.detail?.periodEnd === periodEnd)
    .map((r) => ({
      errors: r.status !== "success" ? [r.error ?? "The nightly job did not finish."] : r.detail?.snapshot?.errors ?? [],
    }));
}

export const balanceClose: AlertSource = {
  key: "balance-close",
  label: "Month-end close",
  section: "finance",
  href: "/finance/period-close",
  requires: CAP.financeStatementsRead,
  async load(admin, { today }) {
    const { data: events, error: eventsError } = await admin
      .from("balance_period_closes")
      .select("period_end, action, created_at");
    if (eventsError) throw new Error(eventsError.message);

    const periods = unclosedPeriodEnds((events ?? []) as CloseEvent[], today);
    if (periods.length === 0) return [];

    const latestEnded = mostRecentlyEndedMonthEnd(today);
    const [config, review, runs, tasksByPeriod] = await Promise.all([
      readCloseConfig(admin),
      listDuplicateReview(admin),
      recentRecalculations(admin, latestEnded),
      Promise.all(periods.map((p) => listTasksForPeriod(admin, p))),
    ]);
    const duplicates = duplicatesByBlockedPeriod(review.pending.map((c) => c.periodEnd), periods);
    const trouble = recalculationTrouble(runs);

    const openCoaIds = tasksByPeriod.flat().filter((t) => t.status === "open").map((t) => t.coaId);
    const name = new Map<string, string>();
    if (openCoaIds.length > 0) {
      const { data: accounts, error } = await admin
        .from("chart_of_accounts")
        .select("id, account_number, account_name")
        .in("id", Array.from(new Set(openCoaIds)));
      if (error) throw new Error(error.message);
      for (const a of (accounts ?? []) as { id: string; account_number: string | null; account_name: string }[]) {
        name.set(a.id, `${a.account_number ? `${a.account_number} ` : ""}${a.account_name}`);
      }
    }

    const items: AlertItem[] = [];
    periods.forEach((periodEnd, i) => {
      const tasks = tasksByPeriod[i];
      const href = `/finance/period-close/${periodEnd}`;
      const dueDate = dueDateForPeriod(periodEnd, config.dueDay);
      const late = today >= dueDate;
      const month = formatPeriodLabel(periodEnd);
      const before = items.length;

      for (const t of tasks.filter((t) => t.status === "open")) {
        items.push({
          key: `close-task:${t.id}`,
          title: `${name.get(t.coaId) ?? "An account"} needs its ${month} balance`,
          detail: `Due ${t.dueDate}. Enter the month-end figure or skip it with a reason.`,
          href,
          severity: today >= t.dueDate ? "danger" : "info",
          when: t.dueDate,
        });
      }

      const dupes = duplicates.get(periodEnd) ?? 0;
      if (dupes > 0) {
        items.push({
          key: `close-duplicates:${periodEnd}`,
          title: `${plural(dupes, "possible duplicate")} to review before ${month} can close`,
          detail: `The same payment may be on the books twice. Answer each one; "not a duplicate" is an answer.`,
          href: "/finance/transactions/duplicates",
          severity: late ? "danger" : "info",
          when: dueDate,
        });
      }

      // Only the latest ended month is recalculated nightly, so it is the only
      // one the runs say anything about.
      if (trouble && periodEnd === latestEnded) {
        items.push({
          key: `close-recalculation:${periodEnd}`,
          title: `${month}'s figures failed to recalculate on ${trouble.failed} of the last ${plural(trouble.of, "night")}`,
          detail: `Closing reruns this and will refuse when it fails; pressing Close again may get through. This one needs a fix, not an answer: ${trouble.latestError.slice(0, 200)}`,
          href,
          severity: "danger",
          when: dueDate,
        });
      }

      if (items.length === before && late && everyTaskAnswered(tasks)) {
        items.push({
          key: `close-period:${periodEnd}`,
          title: `${month} is ready to close`,
          detail: `Every balance is in, nothing is waiting for review, and the close was due ${dueDate}. Review the coverage and close the period.`,
          href,
          severity: "info",
          when: dueDate,
        });
      }
    });
    return items;
  },
};

// ── Tax filings due ──────────────────────────────────────────────────────────

export const taxFilings: AlertSource = {
  key: "tax-filings",
  label: "Tax filings due",
  section: "finance",
  href: "/finance/tax",
  requires: CAP.taxRead,
  async load(admin, { today }) {
    const [tasks, schedules] = await Promise.all([
      listTasks(admin, { status: "open" }),
      listSchedules(admin),
    ]);
    const leadDays = new Map(schedules.map((s) => [s.id, s]));
    const items: AlertItem[] = [];
    for (const t of tasks) {
      const urgency = taskDueStatus(t, leadDays.get(t.schedule_id), today);
      if (urgency === "open") continue;
      let label = t.filing_key;
      try { label = getParty(t.filing_key).label; } catch { /* an unregistered party keeps its key */ }
      items.push({
        key: `tax:${t.id}`,
        title: `${label} ${urgency === "overdue" ? "was due" : "is due"} ${t.due_date}`,
        detail: `Period ${t.period_start} to ${t.period_end}. Review the worksheet and file it.`,
        href: `/finance/tax/${t.id}`,
        severity: urgency === "overdue" ? "danger" : "info",
        when: t.due_date,
      });
    }
    return items;
  },
};

// ── Integrations that stopped working ────────────────────────────────────────

export const connections: AlertSource = {
  key: "connections",
  label: "Integrations needing attention",
  section: "finance",
  href: "/settings/finance/balance-sheet-accounts",
  requires: CAP.financeTransactionsManage,
  async load(admin) {
    const all = await listConnections(admin);
    return all
      .filter((c) => c.status === "needs_reauth" || c.status === "error")
      .map((c) => ({
        key: `connection:${c.id}`,
        title: c.status === "needs_reauth"
          ? `${c.label} (${c.provider}) needs to be reconnected`
          : `${c.label} (${c.provider}) failed its last read`,
        detail: c.status === "needs_reauth"
          ? "The connection expired. Automatic balances stop until it is reconnected."
          : (c.lastError ?? "It will retry on the next run."),
        href: "/settings/finance/balance-sheet-accounts",
        severity: "danger" as const,
        when: c.lastSyncedAt ? c.lastSyncedAt.slice(0, 10) : null,
      }));
  },
};

export const FINANCE_SOURCES: AlertSource[] = [balanceClose, taxFilings, connections];
