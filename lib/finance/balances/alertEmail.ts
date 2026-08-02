/**
 * Pure renderer for the lead-time alert email fired by the `balance-close`
 * cron (app/api/cron/balance-close/route.ts) once an open balance_close_tasks
 * row crosses its due_date - alert_lead_days threshold (see
 * tasksNeedingAlert in lib/finance/balances/closeTasks.ts). No DB/network
 * access here -- the cron route owns calling sendEmail with the result.
 * Mirrors lib/tax/alertEmail.ts's structure and tone.
 *
 * One email per PERSON, covering all of their accounts, rather than one email
 * per account. The eligibility rule is unchanged and still decided entirely by
 * tasksNeedingAlert; grouping only decides who each of those alerts is
 * addressed to, so a run sends the same number of alerts it always did -- split
 * by recipient instead of pooled at the admin address.
 */
import { env, APP_URL_FALLBACK } from "@/lib/env";

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
  /**
   * True when this went to the admin address because nobody is named on these
   * accounts. Worth saying out loud: the recipient is being asked to do work
   * that was never assigned to them, and the fix is a settings change they
   * would otherwise have no reason to know about.
   */
  unassigned = false,
): RenderedBalanceCloseEmail {
  // Deep-links to the period being chased, so the screen opens on the month the
  // email is about rather than on whichever month happens to be current when it
  // is eventually read.
  const base = env.appUrl();
  const entryUrl = `${base}/finance/transactions/manual-entries?periodEnd=${periodEnd}`;
  const subject = `Balance sheet close ${periodEnd} — ${tasks.length} account${tasks.length === 1 ? "" : "s"} need a balance`;

  const items = tasks
    .map(
      (t) =>
        `<li>${t.accountNumber ? `${t.accountNumber} — ` : ""}${t.accountName} (due <strong>${t.dueDate}</strong>)</li>`,
    )
    .join("");

  /**
   * A link to localhost is worse than no link: it looks like one, and it does
   * nothing at all from anybody's phone. `env.appUrl()` falls back to localhost
   * when NEXT_PUBLIC_APP_URL is unset, which it currently is in the deployment
   * -- so say plainly that the address is missing rather than printing an
   * anchor that cannot work. This is a hosting setting and cannot be fixed from
   * code; making it visible in the one place it actually breaks is what code
   * can do about it.
   */
  const link =
    base === APP_URL_FALLBACK
      ? `<p>Open the app and go to <strong>Finance &rarr; Transactions &rarr; Manual Entries</strong> to enter them.
         (A direct link could not be included: this app's public web address has not been configured.)</p>`
      : `<p><a href="${entryUrl}">Enter balances</a></p>`;

  const unassignedNote = unassigned
    ? `<p>Nobody is named as responsible for ${tasks.length === 1 ? "this account" : "these accounts"} yet, so this
       came to you. Naming someone under Settings &rarr; Finance &rarr; Balance Sheet Accounts sends it straight to
       them next month.</p>`
    : "";

  const html = `
    <p>The balance sheet for the period ending <strong>${periodEnd}</strong> can't close until the
    following accounts have a balance entered:</p>
    <ul>${items}</ul>
    ${link}
    ${unassignedNote}
  `.trim();

  return { subject, html };
}
