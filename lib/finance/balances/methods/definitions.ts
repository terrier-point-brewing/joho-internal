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
import { registerMethod, CLOSE_DUE_DAYS_KEY } from "./registry";
import type { BalanceMethod } from "./registry";
import { INVENTORY_POOL_KEY } from "../providers/inventoryOnHand";
import type { CoaAccountRef } from "../../financials/types";

const isReceivable = (coa: CoaAccountRef) => coa.statementSection === "ar";
const isEquity = (coa: CoaAccountRef) => coa.statementSection === "equity";
const isCurrentLiability = (coa: CoaAccountRef) => coa.statementSection === "other_current_liabilities";
const isBank = (coa: CoaAccountRef) => coa.statementSection === "bank";
const isOtherCurrentAsset = (coa: CoaAccountRef) => coa.statementSection === "other_current_assets";

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
  /**
   * Setup here is about the ARRANGEMENT, not the figure.
   *
   * This method used to declare an `operatorBalance` field, which put a dollar
   * input on the Settings screen and broke that screen's own rule: Settings
   * holds rules, Transactions holds values. For Square that field is right --
   * its anchor is a genuine one-off, asked for once because Square publishes no
   * running balance to start from. For manual entry it is wrong, because typing
   * the balance is not something you finish. It is the job, every month,
   * forever. Setting the account up means deciding WHO does that job and BY
   * WHEN; doing it happens under Finance > Period Close.
   */
  setup: [
    {
      kind: "user",
      key: "responsibleUserId",
      label: "Person responsible for this balance",
      help: "Whoever checks this account and enters its balance each month. They are the one emailed when the balance is due, so name a person rather than leaving it to whoever notices.",
    },
    {
      // Optional because there is already a business-wide close deadline, and
      // an account that says nothing should inherit it rather than sit
      // unconfigured. Set it where an account genuinely runs on its own clock.
      kind: "number",
      key: CLOSE_DUE_DAYS_KEY,
      unit: "days",
      optional: true,
      label: "Days after month end this is due",
      help: "How long after a month ends this balance should be entered. Leave it blank to use the deadline set for the business as a whole, and fill it in only for an account that genuinely takes longer, such as one waiting on a statement in the post.",
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

/**
 * GL 1210 Raw Materials, GL 1220 Packaging Materials and GL 1230 Finished Goods.
 *
 * ── One method, not one per account ──────────────────────────────────────────
 * All three ask the same question -- what is on the shelf, and what did it cost
 * -- of a different shelf. That difference is a SETUP FIELD, in the same way
 * Ramp's is "which Ramp account": the calculation is declared once and the
 * account says which thing it holds. Writing `rawMaterialsInventory` and
 * `packagingInventory` as separate methods would have put the same arithmetic in
 * two places, and finished goods would have been a third copy.
 *
 * ── Why 1240 Taproom Merchandise is not offered here ─────────────────────────
 * Not an oversight, and not something to widen the pool list for later without
 * the missing data arriving first. Merchandise has no cost column anywhere in
 * the system -- Square publishes a price, never a cost -- so there is nothing to
 * value it against. It stays on Manual entry, which is an honest answer, rather
 * than getting a calculation that quietly reads low.
 */
const inventoryOnHand: BalanceMethod = {
  key: "inventoryOnHand",
  label: "Inventory on hand",
  kind: "calculation",
  summary: "Counts what is on the shelf today and prices it at what it cost you.",
  appliesTo: isOtherCurrentAsset,
  setup: [
    {
      kind: "select",
      key: INVENTORY_POOL_KEY,
      label: "Which inventory this account holds",
      help: "Pick what this account is for. Raw materials are the malt, hops, yeast and fruit tracked under Production, Ingredients; packaging materials are the cans, lids, labels, PakTechs and trays; finished goods are the packaged beer sitting in cold storage. Nothing can be valued until this is chosen, because the calculation would otherwise not know which shelf to count.",
      options: [
        { value: "rawMaterials", label: "Raw materials (ingredients)" },
        { value: "packagingMaterials", label: "Packaging materials" },
        { value: "finishedGoods", label: "Finished goods (packaged beer in cold storage)" },
      ],
    },
  ],
  steps: [
    {
      providerKey: "inventoryOnHand",
      label: "On hand at cost",
      description:
        "What is recorded as on hand, priced at cost. Raw and packaging materials are counted item by item at their unit cost. Finished goods are priced from the recipe and the packaging it went into — the ingredients the beer calls for, plus its cans, lids, labels, PakTechs and trays — and cover materials only, with no labour or brewery overhead. Anything nobody has priced yet counts as nothing, so the figure reads low rather than failing; a recipe with no ingredients entered is the usual reason. Packaging belonging to a contract-brewing partner is left out as that customer's stock, but their beer in cold storage is NOT — beer becomes theirs when it ships, so until then it is yours.",
      source: "Production ingredient and packaging records",
      direction: "add",
    },
    postingsStep(
      "Direct adjustments",
      "Anything coded straight to this account rather than arriving through the production records — a write-down, or an opening figure booked by hand. Usually nothing, but it would be silently lost without this step.",
      "net",
    ),
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
  setup: [
    {
      kind: "connection",
      key: "connectionId",
      provider: "ramp",
      // Ramp authenticates from app-level credentials that already exist for
      // the expense sync, so the account list can simply be fetched. Nothing to
      // sign in to.
      connect: "discover",
      label: "Ramp account",
      help: "Choose which of your Ramp accounts this general ledger account represents, so the right balance is read each month.",
    },
  ],
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
  // Three fields, in the order an operator can actually do them: there is
  // nothing to anchor until the account is linked. The operatorBalance field is
  // also what raises this account's month-end close task, which is how the
  // outflow half gets corrected today -- see providers/squareBalance.ts.
  setup: [
    {
      kind: "connection",
      key: "connectionId",
      provider: "square",
      connect: "discover",
      label: "Square account",
      help: "Choose which Square business this general ledger account holds the money for.",
    },
    {
      kind: "operatorBalance",
      key: "operatorBalance",
      label: "Balance you read off Square",
      help: "Square never publishes a running balance, so the calculation needs a figure a person has checked to start from. This one is only the starting point — each month end asks for it again under Finance, Transactions, Manual Entries.",
    },
    {
      // Read by squareDrift.ts, which uses the named account's imported bank
      // lines to split the month-end difference into transfers it can see and a
      // remainder it cannot. Still OPTIONAL: an account without it reconciles
      // exactly as it did before the bank feed existed -- one undifferentiated
      // figure -- which is a lesser answer but a correct one. Requiring it would
      // turn a working account into an unconfigured one for the sake of an
      // improvement it can live without.
      kind: "account",
      key: "sweepDestinationCoaId",
      sections: ["bank"],
      optional: true,
      label: "Bank account Square pays out to",
      help: "Which of your bank accounts Square moves this money into. Square never reports those transfers, so naming the account here is what lets the monthly difference be explained from the bank's own records instead of being left as one unexplained figure.",
    },
  ],
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
  setup: [
    {
      kind: "connection",
      key: "connectionId",
      provider: "plaid",
      // The one flow that cannot be a plain list: the operator signs in at
      // their own bank, and only that sign-in produces anything to choose from.
      connect: "authorize",
      label: "Bank account",
      help: "Sign in at your bank to let this app read the balance, then choose which of your accounts this general ledger account represents.",
    },
  ],
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
  inventoryOnHand,
  rampAccountBalance,
  squareStoredBalance,
  plaidBankBalance,
];

for (const method of BUILT_IN_METHODS) registerMethod(method);
