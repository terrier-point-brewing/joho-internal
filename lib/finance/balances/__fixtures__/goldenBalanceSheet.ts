/**
 * Frozen capture of what the PROVIDER-era pipeline actually produced in
 * production, read straight out of gl_account_balances on 2026-08-01 (project
 * drlsazatrcrdwaihjmex). This is the equivalence gate for the method refactor:
 * wrapping the atomic providers into composite methods must not move a single
 * cent.
 *
 * These are REAL queried values, not invented ones. A fixture that does not
 * match production can hide the very bug it exists to catch -- the tip-accrual
 * defect (2310 off by 202,529) shipped precisely because no such capture
 * existed at the time.
 *
 * ── Why the contribution keys must not change ────────────────────────────────
 * `contributions` is keyed by provider_key today. The method refactor keeps
 * every STEP key byte-identical to the provider key it replaces:
 *
 *   salesTaxPayable      -> steps "taxAccrual", "transactionPostings"
 *   undistributedTips    -> steps "tipAccrual", "transactionPostings"
 *   accountsReceivable   -> steps "openInvoiceAr", "transactionPostings"
 *   retainedEarnings     -> step  "retainedEarnings"
 *
 * That is a deliberate constraint, not a coincidence. It means (a) this fixture
 * compares equal before and after with no key translation, (b) historical
 * snapshot rows written by the provider era stay renderable by the new
 * explainer panel, and (c) no backfill of gl_account_balances is required.
 *
 * Sign convention is the codebase INTERNAL one (assets positive, liabilities
 * and equity negative) -- these are stored values, pre-presentation-flip.
 */

export interface GoldenBalance {
  accountNumber: string;
  accountName: string;
  balanceCents: number;
  contributions: Record<string, number>;
  isFrozen: boolean;
}

/** period_end -> the exact rows gl_account_balances held at capture time. */
export const GOLDEN_BALANCE_SHEET: Record<string, GoldenBalance[]> = {
  "2026-06-30": [
    {
      accountNumber: "1310",
      accountName: "Security Deposits Paid",
      balanceCents: 312_000,
      contributions: { transactionPostings: 312_000 },
      isFrozen: true,
    },
    {
      accountNumber: "2220",
      accountName: "Sales & Excise Taxes Payable:North Carolina Department of Revenue Payable",
      balanceCents: -45_026,
      contributions: { taxAccrual: -186_559, transactionPostings: 141_533 },
      isFrozen: true,
    },
    {
      // Single-contribution month: transactionPostings returned null for 2250
      // in June (no direct postings), so only the accrual is recorded. The
      // method must still write ONE contribution here, not a spurious zero.
      accountNumber: "2250",
      accountName: "Sales & Excise Taxes Payable:Wake County Tax Payable",
      balanceCents: -14_486,
      contributions: { taxAccrual: -14_486 },
      isFrozen: true,
    },
    {
      accountNumber: "2310",
      accountName: "Payroll Liabilities:Undistributed Tips",
      balanceCents: -41_746,
      contributions: { tipAccrual: -329_703, transactionPostings: 287_957 },
      isFrozen: true,
    },
    {
      accountNumber: "2420",
      accountName: "Customer Prepayments / Deposits:Equipment Deposits",
      balanceCents: -8_000,
      contributions: { transactionPostings: -8_000 },
      isFrozen: true,
    },
    {
      accountNumber: "3300",
      accountName: "Retained Earnings",
      balanceCents: -618_028,
      contributions: { retainedEarnings: -618_028 },
      isFrozen: true,
    },
  ],

  "2026-07-31": [
    {
      accountNumber: "1100",
      accountName: "Accounts receivable",
      balanceCents: 982_188,
      contributions: { openInvoiceAr: 982_188 },
      isFrozen: false,
    },
    {
      accountNumber: "1310",
      accountName: "Security Deposits Paid",
      balanceCents: 312_000,
      contributions: { transactionPostings: 312_000 },
      isFrozen: false,
    },
    {
      accountNumber: "2220",
      accountName: "Sales & Excise Taxes Payable:North Carolina Department of Revenue Payable",
      balanceCents: 97_974,
      contributions: { taxAccrual: -297_509, transactionPostings: 395_483 },
      isFrozen: false,
    },
    {
      accountNumber: "2230",
      accountName: "Sales & Excise Taxes Payable:Out Of Scope Agency Payable",
      balanceCents: 40_600,
      contributions: { transactionPostings: 40_600 },
      isFrozen: false,
    },
    {
      accountNumber: "2250",
      accountName: "Sales & Excise Taxes Payable:Wake County Tax Payable",
      balanceCents: -16_814,
      contributions: { taxAccrual: -25_458, transactionPostings: 8_644 },
      isFrozen: false,
    },
    {
      // The worked example in the Settings explainer panel. tipAccrual alone
      // would report -577,257 -- eight times the true liability. This row is
      // the standing proof that the two steps must never be separable.
      accountNumber: "2310",
      accountName: "Payroll Liabilities:Undistributed Tips",
      balanceCents: -72_397,
      contributions: { tipAccrual: -577_257, transactionPostings: 504_860 },
      isFrozen: false,
    },
    {
      accountNumber: "2420",
      accountName: "Customer Prepayments / Deposits:Equipment Deposits",
      balanceCents: -24_000,
      contributions: { transactionPostings: -24_000 },
      isFrozen: false,
    },
    {
      accountNumber: "3300",
      accountName: "Retained Earnings",
      balanceCents: -2_848_030,
      contributions: { retainedEarnings: -2_848_030 },
      isFrozen: false,
    },
  ],
};

/**
 * Every step key the golden capture contains. The method registry must emit
 * exactly these keys and no others for the seeded accounts -- a renamed step
 * silently orphans historical contributions rather than failing loudly.
 */
export const GOLDEN_STEP_KEYS = [
  "openInvoiceAr",
  "retainedEarnings",
  "taxAccrual",
  "tipAccrual",
  "transactionPostings",
] as const;

/** Sum of every account's balance for a period, in internal-convention cents.
 *  Assets + Liabilities + Equity should trend to 0 as accounts gain sources;
 *  it is -1,528,479 at capture time because 39 accounts are still unsourced. */
export function goldenPeriodTotal(periodEnd: string): number {
  return (GOLDEN_BALANCE_SHEET[periodEnd] ?? []).reduce((sum, r) => sum + r.balanceCents, 0);
}
