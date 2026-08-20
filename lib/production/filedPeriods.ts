// lib/production/filedPeriods.ts
//
// Has the excise on this shipment already been filed with somebody?
//
// The excise worksheets read `export_transactions` by `created_at` and sum
// `export_transaction_taxes.amount_usd` (lib/tax/parties/ncDorBeerExcise/calc.ts
// and ttbBeerExcise/calc.ts). Nothing in that path looks at invoice status, so a
// shipment's excise lands in a return the moment it is written, whether or not it
// was ever billed.
//
// That makes editing a shipment row a filing question, not just a data question.
// Deleting or restating a row whose date falls inside a period someone has
// already submitted silently changes a number a government has on file — and
// nothing would surface it, because the worksheet recomputes from scratch every
// time it is opened.
//
// So a revision asks this module first. An open period is corrected in place; a
// filed one is corrected with a reversal dated today, which nets out in the
// period the correction actually happened. This is the same reasoning
// writeRefundReturn already applies to returns, applied one step earlier.

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The filings whose base is `export_transactions`. Sales-tax filings are absent
 * on purpose: they read POS lines and invoice lines, neither of which a shipment
 * revision touches.
 */
export const EXCISE_FILING_KEYS = ["nc_dor_beer_excise", "ttb_beer_excise"] as const;

/** A filing that has been submitted, and the span it covered. */
export interface FiledPeriod {
  filingKey: string;
  periodStart: string;
  periodEnd: string;
  submittedOn: string | null;
}

export interface FilingCheck {
  /** True when at least one submitted excise return already counted this date. */
  isFiled: boolean;
  /** The filings that counted it. Empty when open. */
  periods: FiledPeriod[];
}

/**
 * PURE. Which of the given filed periods cover `shippedOn` (a YYYY-MM-DD date).
 *
 * Dates are compared as strings, which is correct here and not laziness:
 * `tax_tasks.period_start`/`period_end` are DATE columns and arrive as
 * YYYY-MM-DD, a format where lexical and chronological order are the same.
 * Parsing them into Date objects would introduce a timezone the filing does not
 * have — a shipment on the last day of a month could land in the previous one.
 */
export function periodsCovering(shippedOn: string, filed: FiledPeriod[]): FiledPeriod[] {
  const day = shippedOn.slice(0, 10);
  return filed.filter((p) => day >= p.periodStart && day <= p.periodEnd);
}

/**
 * Whether any submitted excise return already counted a shipment on this date.
 *
 * A task counts as filed once it is `completed` OR has a `submitted_on` — the two
 * are set at different moments by the tax-tasks flow (a return can be submitted
 * days before someone marks the task done) and either one means the number is
 * out of our hands.
 *
 * FAILS CLOSED. If the tax_tasks read errors, this reports the period as filed.
 * The consequence of being wrong in that direction is a reversal row the operator
 * did not strictly need; the consequence of being wrong the other way is an
 * unannounced restatement of a filed return.
 */
export async function isDateInFiledExcisePeriod(
  supabase: SupabaseClient,
  shippedOn: string,
): Promise<FilingCheck> {
  const day = shippedOn.slice(0, 10);

  const { data, error } = await supabase
    .from("tax_tasks")
    .select("filing_key, period_start, period_end, status, submitted_on")
    .in("filing_key", EXCISE_FILING_KEYS as unknown as string[])
    .lte("period_start", day)
    .gte("period_end", day);

  if (error) {
    return {
      isFiled: true,
      periods: [{ filingKey: "unknown", periodStart: day, periodEnd: day, submittedOn: null }],
    };
  }

  const filed: FiledPeriod[] = (data ?? [])
    .filter((t) => t.status === "completed" || t.submitted_on != null)
    .map((t) => ({
      filingKey: t.filing_key as string,
      periodStart: t.period_start as string,
      periodEnd: t.period_end as string,
      submittedOn: (t.submitted_on as string | null) ?? null,
    }));

  return { isFiled: filed.length > 0, periods: filed };
}

/** Human-readable filing names, for the sentence an operator reads before revising. */
const FILING_LABELS: Record<string, string> = {
  nc_dor_beer_excise: "NC beer excise",
  ttb_beer_excise: "TTB beer excise",
};

/**
 * The one sentence explaining why a revision will be booked as a reversal.
 * Returns null when nothing was filed and the revision is a plain correction.
 */
export function filedPeriodExplanation(check: FilingCheck): string | null {
  if (!check.isFiled || check.periods.length === 0) return null;
  const names = [...new Set(check.periods.map((p) => FILING_LABELS[p.filingKey] ?? p.filingKey))];
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `This shipment falls in a ${list} period that has already been filed, so the correction will be booked as a reversal dated today rather than by editing the original. The filed return stays as filed.`;
}
