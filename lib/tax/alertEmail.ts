/**
 * Pure renderer for the lead-time alert email fired by the `tax-tasks` cron
 * (`app/api/cron/tax-tasks/route.ts`) once a task crosses its
 * `due_date - lead_days` threshold (see `tasksNeedingAlert` in
 * `lib/tax/tasks.ts`). No DB/network access here — the cron route owns
 * calling `sendEmail` with the result.
 */
import { env } from "@/lib/env";
import type { TaxPartyTemplate, TaxSchedule, TaxTask } from "./types";

export interface RenderedTaxAlertEmail {
  subject: string;
  html: string;
}

export function renderTaxAlertEmail(
  task: TaxTask,
  party: TaxPartyTemplate,
  // Signature includes `schedule` per the cron's call shape (it already has
  // it in hand from `listSchedules`) even though the current copy doesn't
  // need schedule fields beyond what's on `task` — kept for parity with the
  // interface and so a future frequency/label tweak doesn't require a
  // call-site change.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  schedule: TaxSchedule,
): RenderedTaxAlertEmail {
  const worksheetUrl = `${env.appUrl()}/finance/tax/${task.id}`;
  const subject = `${party.label} due ${task.due_date} — review & submit`;
  const html = `
    <p>${party.label} is due <strong>${task.due_date}</strong> for the period
    <strong>${task.period_start}</strong> – <strong>${task.period_end}</strong>.</p>
    <p><a href="${worksheetUrl}">Review and submit the worksheet</a></p>
  `.trim();

  return { subject, html };
}
