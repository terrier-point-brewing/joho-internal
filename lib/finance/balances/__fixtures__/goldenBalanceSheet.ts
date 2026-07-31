/**
 * Frozen pre-PR-B balance sheet, captured from PRODUCTION.
 *
 * PROVENANCE — this is the whole point of the file, so read it before trusting
 * or editing anything below.
 *
 *   Captured 2026-07-30 by running the PRE-PR-B `buildFinancials({ statement:
 *   "balance_sheet", year: 2026 })` — i.e. the real old code at main commit
 *   8f90c0a, before any provider existed — against the live production
 *   database, and aggregating the resulting FinancialsRow[] per account.
 *
 * These numbers were NOT derived from the new provider path, and NOT computed
 * by hand. That is what makes them an equivalence gate: the new path has to
 * reproduce a number it had no part in producing.
 *
 * WHY THIS FILE EXISTS: PR B's first attempt at an "equivalence gate" asserted
 * `displayed === -normalizeSignedCents(raw)` — deriving its own expectation from
 * the same function under test, which is true by construction for any flip and
 * therefore constrains nothing. Six real defects passed it. See
 * `scripts/balance-sheet-parity.ts` for the gate that replaced it.
 *
 * SIGN CONVENTION: internal (`lib/finance/financials/normalizeSign.ts`) —
 * assets positive, liabilities and equity NEGATIVE. These are pre-presentation-
 * flip values. A parity run must compare against these, not against what the
 * statement renders.
 */

/** Period the capture covers. BS mode was cumulative-from-inception through this month end. */
export const GOLDEN_PERIOD_END = "2026-07-31";
export const GOLDEN_CAPTURED_AT_COMMIT = "8f90c0a";

export interface GoldenAccount {
  accountNumber: string;
  accountName: string;
  statementSection: string;
  /** Cumulative internal-convention cents through GOLDEN_PERIOD_END. */
  totalCents: number;
  /** Which fetch sources contributed, in the OLD pipeline's vocabulary. */
  sources: string[];
  /**
   * Set ONLY where the new path is deliberately expected to differ because the
   * old path was wrong. Parity treats a match against this value as a pass and
   * a match against `totalCents` as a FAILURE — the bug must not be reproduced.
   */
  knownDivergence?: { expectedNewCents: number; why: string };
}

/**
 * Every balance-sheet-section account that carried a NON-ZERO balance.
 *
 * An account absent from this list produced nothing in the old pipeline, and
 * the new path must not invent a balance for it. GL 2430 Contract Brewing
 * Deposits is the instructive absence: it has 5 invoice_line_items rows
 * totalling 645,948, and every one of them sits on a **voided** invoice. The
 * old pipeline drops them via `.neq("invoices.status", "voided")`. A provider
 * that omits that filter silently invents $6,459.48 of liability.
 *
 * (An earlier draft of this fixture asserted 645,948 as 2430's expected value,
 * and then explained its own absence with a second wrong reason — that invoice
 * lines are booked on `net_sales_cents`. They are booked on `total_cents`. Both
 * errors came from reasoning about the pipeline instead of running it, which is
 * the entire argument for capturing golden values rather than deriving them.)
 */
export const GOLDEN_BALANCE_SHEET: GoldenAccount[] = [
  {
    accountNumber: "1100",
    accountName: "Accounts receivable",
    statementSection: "ar",
    totalCents: 1_626_536,
    sources: ["invoices"],
  },
  {
    // NOT seeded by PR B's migration. Present here because the old pipeline
    // produced it from ordinary expense postings; if the new path has no source
    // configured for 1310, this row silently disappears from the statement.
    accountNumber: "1310",
    accountName: "Security Deposits Paid",
    statementSection: "other_current_assets",
    totalCents: 312_000,
    sources: ["expenses"],
  },
  {
    // Two contributions: tax PAYMENTS via expenses (+395,483 across 4 rows,
    // normalized) and tax COLLECTIONS via the accrual (−291,519).
    accountNumber: "2220",
    accountName: "Sales & Excise Taxes Payable:North Carolina Department of Revenue Payable",
    statementSection: "other_current_liabilities",
    totalCents: 103_964,
    sources: ["expenses", "sales_tax_accrual"],
  },
  {
    accountNumber: "2230",
    accountName: "Sales & Excise Taxes Payable:Out Of Scope Agency Payable",
    statementSection: "other_current_liabilities",
    totalCents: 40_600,
    sources: ["expenses"],
  },
  {
    accountNumber: "2250",
    accountName: "Sales & Excise Taxes Payable:Wake County Tax Payable",
    statementSection: "other_current_liabilities",
    totalCents: -16_347,
    sources: ["expenses", "sales_tax_accrual"],
  },
  {
    // Two contributions, and PR B seeds only the second. Tip PAYOUTS arrive as
    // expenses (+202,529); tip COLLECTIONS as the square_orders accrual
    // (−566,678). A tipAccrual-only source makes this liability gross tips from
    // inception, rising forever and never settling.
    //
    // Note also the collections figure: 566,678, not the 561,648 an unbounded
    // query returns. The old pipeline bounds by period end. A naive query is
    // ALSO subject to PostgREST's 1000-row cap, which reports 300,692 — barely
    // half. Both wrong numbers were proposed before this capture existed.
    accountNumber: "2310",
    accountName: "Payroll Liabilities:Undistributed Tips",
    statementSection: "other_current_liabilities",
    totalCents: -364_149,
    sources: ["expenses", "square_orders"],
    knownDivergence: {
      // Old: tipAccrual (all collections, cumulative) + only the payroll-split
      // payouts that happened to land in the single collapsed month bucket.
      // New: collections + ALL payouts through periodEnd. Difference 302,331.
      expectedNewCents: -67_347,
      why:
        "The old balance sheet DROPPED payroll-split allocations outside its one " +
        "synthetic month. aggregateRows.ts:395-397 prorates a payroll split across " +
        "the months its pay period spans, then keeps an allocation only if " +
        "`monthSet.has(r.monthKey)` — and balance-sheet mode collapsed every record " +
        "onto a single canonical month key. So a June tip payout vanished from a " +
        "July-31 cumulative balance. GL 2310's payout side therefore only ever " +
        "reflected the current month, while its collections side was cumulative — " +
        "mismatched bases on the same account, overstating the liability by 302,331. " +
        "A cumulative liability must include every payout through the period end, " +
        "so the new path is correct and this divergence must NOT be 'fixed' back.",
    },
  },
  {
    accountNumber: "2420",
    accountName: "Customer Prepayments / Deposits:Equipment Deposits",
    statementSection: "other_current_liabilities",
    totalCents: -24_000,
    sources: ["pos_line_items"],
  },
];

/** Accounts the new path must produce, keyed by GL number. */
export const GOLDEN_BY_ACCOUNT: ReadonlyMap<string, GoldenAccount> = new Map(
  GOLDEN_BALANCE_SHEET.map((a) => [a.accountNumber, a]),
);
