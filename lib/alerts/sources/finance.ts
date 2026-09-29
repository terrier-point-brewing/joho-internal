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
import { readPeriodClose } from "@/lib/finance/balances/periodCloseState";
import { formatPeriodLabel, mostRecentlyEndedMonthEnd } from "@/lib/finance/balances/periods";
import { getParty } from "@/lib/tax/registry";
import { listSchedules } from "@/lib/tax/schedules";
import { taskDueStatus } from "@/lib/tax/taskDueStatus";
import { listTasks } from "@/lib/tax/tasks";
import type { AlertItem, AlertSource } from "../types";

// ── Month-end close ──────────────────────────────────────────────────────────
// The Financials nag banner, as a list: every account still missing a balance
// for the most recently ended month, and the month itself once it is finished
// but nobody has called it closed.

export const balanceClose: AlertSource = {
  key: "balance-close",
  label: "Month-end close",
  section: "finance",
  href: "/finance/period-close",
  requires: CAP.financeStatementsRead,
  async load(admin, { today }) {
    const periodEnd = mostRecentlyEndedMonthEnd(today);
    const [state, tasks, config] = await Promise.all([
      readPeriodClose(admin, periodEnd),
      listTasksForPeriod(admin, periodEnd),
      readCloseConfig(admin),
    ]);
    if (state?.closed) return [];

    const href = `/finance/period-close/${periodEnd}`;
    const dueDate = dueDateForPeriod(periodEnd, config.dueDay);
    const late = today >= dueDate;
    const month = formatPeriodLabel(periodEnd);
    const open = tasks.filter((t) => t.status === "open");

    const items: AlertItem[] = [];
    if (open.length > 0) {
      const { data: accounts, error } = await admin
        .from("chart_of_accounts")
        .select("id, account_number, account_name")
        .in("id", open.map((t) => t.coaId));
      if (error) throw new Error(error.message);
      const name = new Map(((accounts ?? []) as { id: string; account_number: string | null; account_name: string }[])
        .map((a) => [a.id, `${a.account_number ? `${a.account_number} ` : ""}${a.account_name}`]));
      for (const t of open) {
        items.push({
          key: `close-task:${t.id}`,
          title: `${name.get(t.coaId) ?? "An account"} needs its ${month} balance`,
          detail: `Due ${t.dueDate}. Enter the month-end figure or skip it with a reason.`,
          href,
          severity: today >= t.dueDate ? "danger" : "info",
          when: t.dueDate,
        });
      }
    } else if (late && everyTaskAnswered(tasks)) {
      items.push({
        key: `close-period:${periodEnd}`,
        title: `${month} is ready to close`,
        detail: `Every balance is in and the close was due ${dueDate}. Review the coverage and close the period.`,
        href,
        severity: "info",
        when: dueDate,
      });
    }
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
