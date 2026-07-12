/**
 * Pure form-state shape + submit-gate for the worksheet workspace's
 * `CompletePanel` confirmation form
 * (`app/finance/tax/[taskId]/CompletePanel.tsx`). Kept free of React so it's
 * unit-testable in isolation, same convention as `lib/tax/scheduleConfig.ts`.
 */

export interface CompleteFormState {
  confirmationNumber: string;
  /** Raw text from the money `<input>` — dollars, not yet parsed to cents. */
  amountPaidInput: string;
  /** YYYY-MM-DD, as produced by an `<input type="date">`. */
  submittedOn: string;
  notes: string;
}

/**
 * Gates the "Mark Submitted" button: a confirmation number, a submitted
 * date, and a non-negative finite amount are all required. Notes are
 * optional. Blank/non-numeric amount text (mid-edit) fails the gate rather
 * than silently coercing to 0 — unlike `dollarStringToCents`, which is a
 * lenient *parse* for a controlled input's live value, this is a *submit*
 * gate where "did the user actually enter a valid amount" matters.
 */
export function canSubmitComplete(form: CompleteFormState): boolean {
  if (form.confirmationNumber.trim() === "") return false;
  if (form.submittedOn.trim() === "") return false;

  const amountText = form.amountPaidInput.trim();
  if (amountText === "") return false;
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount < 0) return false;

  return true;
}
