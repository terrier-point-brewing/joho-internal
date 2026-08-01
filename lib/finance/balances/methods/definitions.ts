/**
 * The methods offered in Settings > Finance > Balance Sheet Accounts.
 *
 * Every `description` here is rendered verbatim to a non-technical operator in
 * the "How is this calculated?" panel, and is the only thing standing between
 * them and taking a number on faith. Write them as sentences a bookkeeper would
 * recognise, never as a restatement of the code.
 *
 * ── Method keys are chosen to avoid a data migration where possible ──────────
 * `transactionPostings`, `manualBalance` and `retainedEarnings` reuse the exact
 * provider_key already stored in balance_sheet_account_sources, so the rows for
 * GL 2230, 2420, 2430, 1310 and 3300 resolve as methods with no migration at
 * all. Only the four genuinely composite accounts (2220, 2250, 2310, 1100) need
 * their provider pairs collapsed into a single method key.
 */
import { registerMethod } from "./registry";
import type { BalanceMethod } from "./registry";
import type { CoaAccountRef } from "../../financials/types";

const isReceivable = (coa: CoaAccountRef) => coa.statementSection === "ar";
const isEquity = (coa: CoaAccountRef) => coa.statementSection === "equity";
const isCurrentLiability = (coa: CoaAccountRef) => coa.statementSection === "other_current_liabilities";
const isBank = (coa: CoaAccountRef) => coa.statementSection === "bank";

/**
 * The postings step, reused by three composite methods. Its label and
 * description are supplied per method because the SAME aggregation means
 * different things per account -- on 2220 it is tax remitted to the state, on
 * 2310 it is tips handed to staff. A single generic wording ("amounts coded to
 * this account") would be accurate and useless.
 */
function postingsStep(label: string, description: string, direction: "add" | "subtract" | "net") {
  return {
    providerKey: "transactionPostings",
    label,
    description,
    source: "Invoice lines, POS lines, expenses and bank ledger coded to this account",
    direction,
  } as const;
}

// ── Manual ───────────────────────────────────────────────────────────────────

const manualEntry: BalanceMethod = {
  key: "manualBalance",
  label: "Manual entry",
  kind: "manual",
  summary: "You type the balance yourself each month end.",
  steps: [
    {
      providerKey: "manualBalance",
      label: "Entered balance",
      description:
        "The figure someone entered for this account under Finance > Transactions > Manual Entries for this month end.",
      source: "Manual entries",
      direction: "net",
    },
  ],
};

// ── Transaction postings ─────────────────────────────────────────────────────

const transactionPostings: BalanceMethod = {
  key: "transactionPostings",
  label: "Transaction postings",
  kind: "postings",
  summary: "Adds up everything coded to this account, from the beginning through the month end.",
  steps: [
    postingsStep(
      "Everything coded here",
      "Every invoice line, till sale, expense and bank line assigned to this account, from the beginning of records through this month end.",
      "net",
    ),
  ],
};

// ── Calculations ─────────────────────────────────────────────────────────────

const salesTaxPayable: BalanceMethod = {
  key: "salesTaxPayable",
  label: "Sales tax payable",
  kind: "calculation",
  summary: "Tax you have charged customers, less what you have already remitted to the agency.",
  appliesTo: isCurrentLiability,
  steps: [
    {
      providerKey: "taxAccrual",
      label: "Tax charged to customers",
      description:
        "Sales and excise tax added to customer bills through this month end. This is money you have collected on the agency's behalf and now owe them.",
      source: "Tax lines on Square sales and invoices",
      direction: "add",
    },
    // Wording verified against the live postings on GL 2220: of the four
    // payments there, two are to NC Dept Revenue and Wake County Tax
    // Administration and two are to Argus Beverage Ventures LLC, who settled
    // the tax on the brewery's behalf during an ownership transition. The
    // coding is correct in both cases, so this copy must not promise the payee
    // is the agency -- a reader who opened the expense list and saw a beverage
    // distributor would otherwise conclude the account was miscoded.
    postingsStep(
      "Tax already paid",
      "Payments already made against this tax liability, which reduce what you still owe. The payee may be the agency itself or a third party settling on your behalf.",
      "subtract",
    ),
  ],
};

const undistributedTips: BalanceMethod = {
  key: "undistributedTips",
  label: "Undistributed tips",
  kind: "calculation",
  summary: "Tips your customers paid that you have not yet handed out to staff.",
  appliesTo: isCurrentLiability,
  steps: [
    {
      providerKey: "tipAccrual",
      label: "Tips collected",
      description:
        "Every tip on a completed Square order through this month end. Cancelled orders are excluded, because Square keeps a cancelled order's tip on the header even after withdrawing its items.",
      source: "Completed Square orders",
      direction: "add",
    },
    postingsStep(
      "Tips paid out",
      "Payroll and expense lines coded to this account, which is how tip disbursements reach the books. Without this step the liability would only ever grow and never settle.",
      "subtract",
    ),
  ],
};

const accountsReceivable: BalanceMethod = {
  key: "accountsReceivable",
  label: "Accounts receivable",
  kind: "calculation",
  summary: "What customers still owe you on unpaid invoices.",
  appliesTo: isReceivable,
  steps: [
    {
      providerKey: "openInvoiceAr",
      label: "Unpaid invoices",
      description: "The total of every invoice dated on or before this month end that has not been paid.",
      source: "Open Square invoices",
      direction: "add",
    },
    postingsStep(
      "Direct adjustments",
      "Anything coded straight to receivables rather than arriving as an invoice. Usually nothing, but it would be silently lost without this step.",
      "net",
    ),
  ],
};

const retainedEarnings: BalanceMethod = {
  key: "retainedEarnings",
  label: "Retained earnings",
  kind: "calculation",
  summary: "Every dollar of profit and loss the business has accumulated since it started.",
  appliesTo: isEquity,
  steps: [
    {
      providerKey: "retainedEarnings",
      label: "Accumulated profit and loss",
      description:
        "Total income less total expenses across every month through this month end, calculated from the same figures the profit and loss statement shows.",
      source: "Profit and loss statement",
      direction: "net",
    },
  ],
};

// ── Integrations ─────────────────────────────────────────────────────────────

/**
 * GL 1030 Ramp Operating Account. Single-step on purpose: unlike the accrual
 * pairs above, Ramp reports the account's actual closing balance, so there is
 * no second half of the calculation that could be left off. Adding a postings
 * step would double-count every Ramp movement already reflected in that figure.
 */
const rampAccountBalance: BalanceMethod = {
  key: "rampBalance",
  label: "Ramp account balance",
  kind: "calculation",
  summary: "Takes the balance Ramp itself reports for the connected account on the last day of the month.",
  appliesTo: isBank,
  connectionProvider: "ramp",
  steps: [
    {
      providerKey: "rampBalance",
      label: "Balance held at Ramp",
      description:
        "The balance Ramp shows for the connected account on this month end. It is the available balance, so it can read slightly differently from a statement if a payment was still pending on the last day.",
      source: "Ramp treasury account",
      direction: "net",
    },
  ],
};

/**
 * GL 1040 Square Deposit Account.
 *
 * The opposite situation to Ramp above, and worth reading together. Ramp
 * REPORTS a closing balance, so its method is one step and adding postings
 * would double-count. Square publishes no balance at all, so its method has to
 * build one -- and can only build the half Square actually reports.
 *
 * Two steps rather than three. The instinct -- and the pattern every other
 * composite method here follows -- is to pair the inbound movement with a
 * `transactionPostings` step so the settling side is never missing. That is
 * wrong for this account specifically: 1040's section is "bank", and
 * normalizeSign passes a bank-section cash direction through unchanged, so a
 * sweep to the bank coded here would ADD to the balance it emptied. The outflow
 * is absorbed by re-anchoring instead. See providers/squareBalance.ts.
 */
const squareStoredBalance: BalanceMethod = {
  key: "squareStoredBalance",
  label: "Square balance",
  kind: "calculation",
  summary: "Your last checked Square balance, plus everything Square has paid in since.",
  appliesTo: isBank,
  connectionProvider: "square",
  requiresCloseEntry: true,
  steps: [
    {
      providerKey: "squareBalanceAnchor",
      label: "Last checked balance",
      description:
        "The balance someone read off Square and entered by hand, at the most recent month end up to this one. Square publishes no running balance of its own, so a figure a person has actually confirmed is the only solid starting point.",
      source: "Manual entries",
      direction: "add",
    },
    {
      providerKey: "squarePayoutsSinceAnchor",
      label: "Paid in by Square since then",
      description:
        "Everything Square has settled into the account since that checked figure, already after card processing fees and customer refunds. Money you moved out to your bank is not included, because Square does not report those transfers at all — that is what the month end check corrects.",
      source: "Square payouts",
      direction: "add",
    },
  ],
};

/**
 * GL 1020 Chase Operating, fed from Plaid.
 *
 * One step, for the same reason Ramp's is: the bank's own balance IS the
 * complete balance for the account, since it already reflects every deposit,
 * payment and fee that has posted. Adding a postings step the way the liability
 * methods do would count the same money twice, once as the bank saw it and once
 * as the books recorded it. Where the two disagree, the answer is a
 * reconciliation, not a sum.
 *
 * Where it differs from Ramp: the figure is captured daily rather than read on
 * demand, because Plaid can only answer for right now. See
 * providers/plaidBalance.ts.
 */
const plaidBankBalance: BalanceMethod = {
  key: "plaidBankBalance",
  label: "Bank balance from Plaid",
  kind: "calculation",
  summary: "Uses the balance your bank itself reports on the last day of the month.",
  appliesTo: isBank,
  connectionProvider: "plaid",
  steps: [
    {
      providerKey: "plaidBalance",
      label: "Closing balance at the bank",
      description:
        "The balance your bank reported on the last day of this month, read automatically once a day and saved at the time. Your bank cannot be asked for a past balance later, so a month with no reading that day stays blank rather than showing a nearby day's figure.",
      source: "Chase, read through Plaid",
      direction: "net",
    },
  ],
};

export const BUILT_IN_METHODS: BalanceMethod[] = [
  manualEntry,
  transactionPostings,
  salesTaxPayable,
  undistributedTips,
  accountsReceivable,
  retainedEarnings,
  rampAccountBalance,
  squareStoredBalance,
  plaidBankBalance,
];

for (const method of BUILT_IN_METHODS) registerMethod(method);
