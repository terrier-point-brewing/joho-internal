// Reconciles the two raw sign conventions used across finance sources into
// one signed-cents convention keyed off the mapped account's statement
// section: income-like sections are positive, cost-like sections are
// negative. POS/invoice arrive unsigned-positive; expense/bank arrive
// already-signed by cash direction; refunds are always contra-revenue.
//
// POS/invoice: take the magnitude and re-apply sign from the section --
// these sources carry no direction of their own, so the section is the only
// signal.
//
// Expense/bank on a P&L section: pass the raw cash-direction sign through
// UNCHANGED. Their cash-direction convention (spend negative, credit/inflow
// positive) already equals the target P&L convention (cost negative, income
// positive / cost offset positive) -- re-deriving sign from the section here
// would double-flip a positive credit into a negative (see normalizeSign.test.ts,
// C1 in the Task 15 final review). Expense/bank on a Balance Sheet section
// still needs the abs()+section-sign treatment: an asset-purchase outflow
// (negative cash direction) must read as a positive asset balance.

const POSITIVE_SECTIONS = new Set([
  "revenue",
  "other_income",
  "bank",
  "ar",
  "other_current_assets",
  "fixed_assets",
  "other_assets",
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

// The P&L section subset of POSITIVE_SECTIONS/NEGATIVE_SECTIONS -- mirrors
// lib/finance/accountSections.ts's StatementSection union split (everything
// else there is a Balance Sheet section). Kept local rather than imported
// since accountSections.ts doesn't itself export this split (see
// lib/finance/financials/summaries.ts's PL_SECTIONS for the sibling copy).
const PL_SECTIONS = new Set(["revenue", "other_income", "cogs", "expenses", "other_expense"]);

export function normalizeSignedCents(
  rawCents: number,
  statementSection: string,
  source: "pos" | "invoice" | "expense" | "bank" | "refund" | "tip_accrual" | "tax_accrual"
): number {
  const magnitude = Math.abs(rawCents);

  // Refunds are always contra-revenue, regardless of mapped section.
  if (source === "refund") return -magnitude;

  if (source === "expense" || source === "bank") {
    // P&L section: cash-direction sign already matches the target
    // convention -- pass through unchanged (the C1 fix).
    if (PL_SECTIONS.has(statementSection)) return rawCents;
    // Cash's own ledger (the "bank" section): the raw cash-direction sign IS
    // the desired cash-balance delta already (a deposit/inflow, positive raw,
    // should read as MORE cash on hand; an outflow, negative raw, should read
    // as LESS cash on hand) -- unlike the other BS sections below this isn't
    // cash spent to acquire a target asset or pay down a liability, so it
    // must not be flipped, and unlike the abs()+section-sign treatment it
    // must not be collapsed to a magnitude either (that would make an
    // outflow read as MORE cash, corrupting cashOnHandCents -- see
    // buildFinancials.ts's cashOnHandCents and normalizeSign.test.ts). Mixed
    // inflow/outflow coverage for BS "bank"-section rows generally is a
    // known, separate open item (see fetchSources.ts's fetchBank
    // "deliberately left unfiltered" comment) -- not addressed by this fix.
    if (statementSection === "bank") return rawCents;
    // Balance Sheet section (asset/liability/equity, excluding bank): flip
    // the cash-direction sign. An outflow (negative raw) reduces a liability
    // / increases an asset; an inflow (positive raw) increases a liability /
    // reduces an asset. Using abs()+section-sign here (the old approach)
    // lost the outflow/inflow distinction and made liability paydowns GROW
    // the liability -- see normalizeSign.test.ts, Task 5.
    if (POSITIVE_SECTIONS.has(statementSection) || NEGATIVE_SECTIONS.has(statementSection)) {
      return -rawCents;
    }
    // Unrecognized section: fall back to the source's own cash-direction sign.
    return rawCents;
  }

  // pos/invoice: unsigned-positive input, sign comes entirely from the section.
  if (POSITIVE_SECTIONS.has(statementSection)) return magnitude;
  if (NEGATIVE_SECTIONS.has(statementSection)) return -magnitude;

  // Unrecognized section fallback.
  return magnitude;
}
