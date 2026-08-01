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

export const BUILT_IN_METHODS: BalanceMethod[] = [
  manualEntry,
  transactionPostings,
  salesTaxPayable,
  undistributedTips,
  accountsReceivable,
  retainedEarnings,
];

for (const method of BUILT_IN_METHODS) registerMethod(method);
