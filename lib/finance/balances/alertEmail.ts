/**
 * Pure renderer for the lead-time alert email fired by the `balance-close`
 * cron (app/api/cron/balance-close/route.ts) once an open balance_close_tasks
 * row crosses its due_date - alert_lead_days threshold (see
 * tasksNeedingAlert in lib/finance/balances/closeTasks.ts). No DB/network
 * access here -- the cron route owns calling sendEmail with the result.
 * Mirrors lib/tax/alertEmail.ts's structure and tone.
 */
import { env } from "@/lib/env";

export interface RenderedBalanceCloseEmail {
  subject: string;
  html: string;
}

export interface MissingBalanceAccount {
  accountName: string;
  accountNumber: string | null;
  dueDate: string;
}

export function renderBalanceCloseEmail(
  tasks: MissingBalanceAccount[],
  periodEnd: string,
): RenderedBalanceCloseEmail {
  const entryUrl = `${env.appUrl()}/finance/transactions/manual-entries`;
  const subject = `Balance sheet close ${periodEnd} — ${tasks.length} account${tasks.length === 1 ? "" : "s"} need a balance`;

  const items = tasks
    .map(
      (t) =>
        `<li>${t.accountNumber ? `${t.accountNumber} — ` : ""}${t.accountName} (due <strong>${t.dueDate}</strong>)</li>`,
    )
    .join("");

  const html = `
    <p>The balance sheet for the period ending <strong>${periodEnd}</strong> can't close until the
    following accounts have a manual balance entered:</p>
    <ul>${items}</ul>
    <p><a href="${entryUrl}">Enter balances</a></p>
  `.trim();

  return { subject, html };
}
