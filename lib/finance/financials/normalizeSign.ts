// Reconciles the two raw sign conventions used across finance sources into
// one signed-cents convention keyed off the mapped account's statement
// section: income-like sections are positive, cost-like sections are
// negative. POS/invoice arrive unsigned-positive; expense/bank arrive
// already-signed by cash direction; refunds are always contra-revenue.
// Taking the magnitude and re-applying sign from the section makes both
// input conventions land on the same normalized sign.

const POSITIVE_SECTIONS = new Set([
  "revenue",
  "other_income",
  "bank",
  "ar",
  "other_current_assets",
  "fixed_assets",
]);

const NEGATIVE_SECTIONS = new Set([
  "cogs",
  "expenses",
  "other_expense",
  "ap",
  "credit_card",
  "other_current_liabilities",
  "long_term_liabilities",
  "equity",
]);

export function normalizeSignedCents(
  rawCents: number,
  statementSection: string,
  source: "pos" | "invoice" | "expense" | "bank" | "refund"
): number {
  const magnitude = Math.abs(rawCents);

  // Refunds are always contra-revenue, regardless of mapped section.
  if (source === "refund") return -magnitude;

  if (POSITIVE_SECTIONS.has(statementSection)) return magnitude;
  if (NEGATIVE_SECTIONS.has(statementSection)) return -magnitude;

  // Unrecognized section: fall back to the source's own cash-direction sign.
  return source === "expense" || source === "bank" ? rawCents : magnitude;
}
