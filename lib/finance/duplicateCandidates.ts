/**
 * Find the same real-world transaction ingested from two sources.
 *
 * September 2026's close turned up five of these by hand: a Ramp bill AND the
 * card charge that paid it both expensed, a bill and the wallet debit that
 * settled it, a bill and the Chase line that paid it, and a manual entry that
 * restated a bill someone could not see in the feed. Each doubled an expense,
 * and nothing in the app could have said so — every row was individually valid.
 *
 * ── Why amount and date, and never the name ──────────────────────────────────
 * The two sides are routinely different NAMES for one payee: Prairie Malt bills
 * and Boortmalt charges the card; RahrBSG bills and Brewers Supply Group
 * charges. A name match would have missed every card duplicate found. What the
 * two sides do share is the exact amount to the cent and a few days. Across the
 * whole ledger at the time of writing that rule produced eleven pairs and every
 * one was real, so it is deliberately not loosened with a tolerance.
 *
 * ── Ramp's own links come first ──────────────────────────────────────────────
 * For a bill paid by card, Ramp records WHICH card transaction paid it, and for
 * a refund, which charge it reverses. Where a link exists it is the evidence:
 * the pair is made on it alone, whatever the dates, and neither side is offered
 * to anything else. October 2026 is why. Two RahrBSG bills were both $295.83;
 * the card charge that paid the first settled nine days later, one day from the
 * second, and amount-and-date tied it to the wrong bill.
 *
 * Amount-and-date is still the rule everywhere Ramp has no link: a bill paid
 * from the bank or marked paid by hand, every bank line, every manual entry.
 * Both September duplicates that were not card payments were found that way.
 *
 * ── What this does not do ────────────────────────────────────────────────────
 * It proposes; it never sets anything aside. A candidate is a question for a
 * person ("is this one payment?"), and the answer is recorded elsewhere so the
 * question is not asked twice.
 *
 * Pure: the caller supplies already-fetched rows.
 */
import { formatCurrencyCents } from "@/lib/format";
import { monthEnd } from "@/lib/finance/manualEntries";

export type DuplicateKind = "bill_vs_card" | "bill_vs_ramp_debit" | "bill_vs_bank_line" | "manual_vs_feed" | "bill_vs_bill";

/** How far either side of a bill's own dates its payment may sit and still be the same money. */
export const DEFAULT_WINDOW_DAYS = 7;

/**
 * How far a manual entry's dates may sit from the feed rows it restates. Tight
 * on purpose: a hand entry for "the debit on June 1" names its day, and every
 * extra day in the pool multiplies the combinations that can sum to it by luck.
 */
export const MANUAL_WINDOW_DAYS = 1;

/**
 * How far apart two identical bills from one vendor may be and still look like
 * one order billed twice. Deliberately short: rent is the same bill every
 * month, 26 to 32 days apart, and must never be proposed.
 */
export const BILL_REPEAT_WINDOW_DAYS = 14;

/** How long after a card charge a refund of it may land and still be read as its reversal. */
export const REFUND_WINDOW_DAYS = 60;

/** A manual entry spanning longer than this is an accrual or a proration, not one movement. */
const MANUAL_MAX_SPAN_DAYS = 7;

/** A manual entry can restate a movement NET of others (a bill less an interest credit). */
const MANUAL_MAX_PARTS = 3;

/** One `expenses` row with ramp_object = 'bill'. A bill is several of these, one per line item. */
export interface BillLineInput {
  id: string;
  /** "<ramp bill id>:<line>" — everything before the first colon is the bill. */
  sourceTransactionId: string;
  merchantName: string | null;
  accountingDate: string;
  /** ISO timestamp the bill was paid, null while it is open. */
  settledAt: string | null;
  amountCents: number;
  excluded: boolean;
  /** How Ramp paid the bill (CARD, RTP, CHECK, ...). Informational; the ids below are the link. */
  paymentMethod?: string | null;
  /** Ramp card transaction ids that paid this bill: each a card row's `sourceTransactionId`. */
  paymentTransactionIds?: string[] | null;
}

/** One `expenses` row with ramp_object = 'card' or 'bank'. */
export interface ExpenseInput {
  id: string;
  rampObject: "card" | "bank";
  /** Ramp's id for the transaction: what a bill's payment link and a refund's link point at. */
  sourceTransactionId?: string | null;
  /** On a card refund, the Ramp id of the charge it reverses. */
  originalTransactionId?: string | null;
  merchantName: string | null;
  /** Null while a card charge is still pending — it is not on any statement yet. */
  accountingDate: string | null;
  amountCents: number;
  state: string | null;
  excluded: boolean;
}

/** One `bank_ledger` row. */
export interface BankLineInput {
  id: string;
  source: string;
  name: string | null;
  transactionDate: string;
  amountCents: number;
  flowType: string | null;
}

/** One `manual_entries` row with entry_kind = 'flow'. */
export interface ManualFlowInput {
  id: string;
  label: string | null;
  startDate: string;
  endDate: string;
  amountCents: number;
}

export interface DuplicateSide {
  table: "expenses" | "bank_ledger" | "manual_entries";
  /** Row ids. More than one only for a bill, which is one id per line item. */
  ids: string[];
  /** What a bookkeeper would call it: "Ramp bill", "Card charge", … */
  what: string;
  name: string;
  date: string;
  amountCents: number;
}

export interface DuplicateCandidate {
  /** Stable across runs for the same rows — the key a review is remembered under. */
  key: string;
  kind: DuplicateKind;
  amountCents: number;
  /** The record(s) that already carry this money and stay. */
  matched: DuplicateSide[];
  /** The record that restates it — the one that would be set aside. */
  duplicate: DuplicateSide;
  daysApart: number;
  /** One sentence, shown to a bookkeeper verbatim. */
  reason: string;
  /**
   * Set when the pair rests on Ramp's own record that this charge paid this
   * bill, instead of on a matching amount and date. Absent means "possible":
   * the matcher inferred it. Present means Ramp says so.
   */
  evidence?: "ramp_link";
  /** Month end of the duplicate's date: the month whose expense is doubled. */
  periodEnd: string;
  /**
   * A refund that already undid the duplicate, when there is one.
   *
   * October 2026: a $295.83 card charge matched a bill and was proposed as a
   * duplicate, with nothing on the screen to say the vendor had refunded that
   * charge ten days later. Setting the charge aside would have left the refund
   * counted alone and the expense $295.83 too LOW. A candidate that carries
   * this is already corrected by the vendor, so it must not be set aside.
   */
  reversal?: DuplicateSide;
}

export interface DuplicateInputs {
  billLines: BillLineInput[];
  expenses: ExpenseInput[];
  bankLines: BankLineInput[];
  manualFlows: ManualFlowInput[];
}

// ── dates ───────────────────────────────────────────────────────────────────

function dayNumber(iso: string): number {
  return Math.round(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(dayNumber(a) - dayNumber(b));
}

/** Days from `date` to the nearest edge of [from, to]; 0 inside it. */
function distanceToRange(date: string, from: string, to: string): number {
  const d = dayNumber(date);
  if (d < dayNumber(from)) return dayNumber(from) - d;
  if (d > dayNumber(to)) return d - dayNumber(to);
  return 0;
}

// ── bills ───────────────────────────────────────────────────────────────────

interface Bill {
  billId: string;
  lineIds: string[];
  /** Each remaining line's amount, for telling an identical bill from a same-total one. */
  lineAmounts: number[];
  merchantName: string;
  /** The day it was incurred. */
  date: string;
  /** The UTC day it was paid, the same boundary the cash-flow statement uses. */
  settledDate: string | null;
  amountCents: number;
  /** Ramp card transaction ids recorded as this bill's payment; empty when Ramp has no link. */
  paymentTransactionIds: string[];
}

/**
 * Line items rolled up to the bill they belong to. A line already set aside is
 * left out of the total, because it is no longer expensed: the bill's weight on
 * the statement is what its remaining lines add up to.
 */
export function groupBills(lines: BillLineInput[]): Bill[] {
  const byBill = new Map<string, Bill>();
  for (const line of lines) {
    if (line.excluded) continue;
    const billId = line.sourceTransactionId.split(":")[0];
    const bill = byBill.get(billId);
    if (!bill) {
      byBill.set(billId, {
        billId,
        lineIds: [line.id],
        lineAmounts: [line.amountCents],
        merchantName: line.merchantName ?? "Unnamed vendor",
        date: line.accountingDate,
        settledDate: line.settledAt ? line.settledAt.slice(0, 10) : null,
        amountCents: line.amountCents,
        paymentTransactionIds: [...(line.paymentTransactionIds ?? [])],
      });
      continue;
    }
    for (const id of line.paymentTransactionIds ?? []) {
      if (!bill.paymentTransactionIds.includes(id)) bill.paymentTransactionIds.push(id);
    }
    bill.lineIds.push(line.id);
    bill.lineAmounts.push(line.amountCents);
    bill.amountCents += line.amountCents;
    if (line.accountingDate < bill.date) bill.date = line.accountingDate;
  }
  return [...byBill.values()].filter((b) => b.amountCents !== 0);
}

function billSide(bill: Bill): DuplicateSide {
  return {
    table: "expenses",
    ids: [...bill.lineIds].sort(),
    what: "Ramp bill",
    name: bill.merchantName,
    date: bill.date,
    amountCents: bill.amountCents,
  };
}

// ── the other side of a bill ────────────────────────────────────────────────

interface Counterpart {
  kind: Exclude<DuplicateKind, "manual_vs_feed" | "bill_vs_bill">;
  side: DuplicateSide;
  /** The refund that undid this charge, when the vendor has already given the money back. */
  reversal?: DuplicateSide;
}

/**
 * Card refunds matched to the charge each one undoes.
 *
 * Ramp's link first: a refund that names its `originalTransactionId` undoes
 * that charge and no other, however far apart they are and whatever the
 * merchant is called on each. It counts as having undone the charge only when
 * it is for the whole amount; a partial refund leaves part of the charge
 * standing, so the charge is still a duplicate worth setting aside.
 *
 * Then, only for refunds Ramp gave no link for, the old inference: same
 * merchant, the exact opposite amount, on or after the charge and within
 * REFUND_WINDOW_DAYS. The nearest refund claims a charge, and each refund
 * answers to one charge. A refund that HAS a link is never guessed at, even if
 * the charge it names is not in the table.
 */
function refundsByChargeId(expenses: ExpenseInput[]): Map<string, ExpenseInput> {
  const live = expenses.filter((e) => e.rampObject === "card" && !e.excluded && e.accountingDate && e.state !== "DECLINED");
  const charges = live.filter((e) => e.amountCents < 0);
  const refunds = live
    .filter((e) => e.amountCents > 0)
    .sort((a, b) => (a.accountingDate as string).localeCompare(b.accountingDate as string) || a.id.localeCompare(b.id));

  const out = new Map<string, ExpenseInput>();

  const chargeBySourceId = new Map<string, ExpenseInput>();
  for (const c of charges) if (c.sourceTransactionId) chargeBySourceId.set(c.sourceTransactionId, c);
  for (const refund of refunds) {
    if (!refund.originalTransactionId) continue;
    const charge = chargeBySourceId.get(refund.originalTransactionId);
    if (charge && !out.has(charge.id) && charge.amountCents === -refund.amountCents) out.set(charge.id, refund);
  }

  for (const refund of refunds) {
    if (refund.originalTransactionId) continue;
    const day = dayNumber(refund.accountingDate as string);
    const charge = charges
      .filter(
        (c) =>
          !out.has(c.id) &&
          c.amountCents === -refund.amountCents &&
          (c.merchantName ?? "") === (refund.merchantName ?? "") &&
          dayNumber(c.accountingDate as string) <= day &&
          day - dayNumber(c.accountingDate as string) <= REFUND_WINDOW_DAYS,
      )
      // The most recent charge before the refund is the one it most plausibly undoes.
      .sort((a, b) => (b.accountingDate as string).localeCompare(a.accountingDate as string) || a.id.localeCompare(b.id))[0];
    if (charge) out.set(charge.id, refund);
  }
  return out;
}

/**
 * Everything that could be a bill's payment recorded a second time.
 *
 * Left out, because they are already answered:
 *   - an expense someone has set aside (`excluded`);
 *   - a declined charge, or a pending one with no date — neither is on a
 *     statement;
 *   - a bank line already typed `bill_settlement`, which is the house way of
 *     saying "this is a bill being paid" and keeps it off the P&L.
 *
 * A bank line of any OTHER flow type stays in, `unclassified` included: it is
 * harmless today and doubles the expense the moment someone maps it.
 */
function counterparts(inputs: DuplicateInputs): Counterpart[] {
  const out: Counterpart[] = [];
  const refunds = refundsByChargeId(inputs.expenses);
  for (const e of inputs.expenses) {
    if (e.excluded || !e.accountingDate || e.state === "DECLINED") continue;
    const refund = refunds.get(e.id);
    out.push({
      reversal: refund && {
        table: "expenses",
        ids: [refund.id],
        what: "Card refund",
        name: refund.merchantName ?? "Unnamed merchant",
        date: refund.accountingDate as string,
        amountCents: refund.amountCents,
      },
      kind: e.rampObject === "card" ? "bill_vs_card" : "bill_vs_ramp_debit",
      side: {
        table: "expenses",
        ids: [e.id],
        what: e.rampObject === "card" ? "Card charge" : "Ramp account debit",
        name: e.merchantName ?? "Unnamed merchant",
        date: e.accountingDate,
        amountCents: e.amountCents,
      },
    });
  }
  for (const b of inputs.bankLines) {
    if (b.flowType === "bill_settlement") continue;
    out.push({
      kind: "bill_vs_bank_line",
      side: {
        table: "bank_ledger",
        ids: [b.id],
        what: b.source === "plaid" ? "Chase bank line" : "Ramp account line",
        name: b.name ?? "Unnamed bank line",
        date: b.transactionDate,
        amountCents: b.amountCents,
      },
    });
  }
  return out;
}

/**
 * What Ramp's bill-to-card links say, before any amount-and-date pairing.
 *
 * `candidates` are the pairs Ramp itself records: a bill and the card charge
 * that paid it, both still counted. Made whatever the dates and whatever the
 * amounts, because the link is the evidence and the dates were what got
 * October 2026 wrong.
 *
 * `billIds` and `chargeIds` are everything a link SPEAKS FOR, a wider set than
 * the pairs: they are read from every bill line, set-aside ones included, and
 * cover a charge that is set aside, declined, still pending or not stored at
 * all. A bill Ramp says was paid by one charge is not offered to another just
 * because that charge has been set aside, and a charge Ramp ties to a
 * set-aside bill is not handed to a same-amount stranger. That would re-open,
 * against the wrong record, a question a person has already answered.
 */
function rampLinkedPairs(
  inputs: DuplicateInputs,
  bills: Bill[],
  others: Counterpart[],
): { candidates: DuplicateCandidate[]; billIds: Set<string>; chargeIds: Set<string> } {
  const cardBySourceId = new Map<string, ExpenseInput>();
  for (const e of inputs.expenses) {
    if (e.rampObject === "card" && e.sourceTransactionId) cardBySourceId.set(e.sourceTransactionId, e);
  }

  const billIds = new Set<string>();
  const chargeIds = new Set<string>();
  for (const line of inputs.billLines) {
    const ids = line.paymentTransactionIds ?? [];
    if (ids.length === 0) continue;
    billIds.add(line.sourceTransactionId.split(":")[0]);
    for (const id of ids) {
      const card = cardBySourceId.get(id);
      if (card) chargeIds.add(card.id);
    }
  }

  // `others` already holds only what is still counted, with its refund attached.
  const counted = new Map<string, Counterpart>();
  for (const o of others) if (o.kind === "bill_vs_card") counted.set(o.side.ids[0], o);

  const candidates: DuplicateCandidate[] = [];
  for (const bill of bills) {
    for (const txnId of bill.paymentTransactionIds) {
      const card = cardBySourceId.get(txnId);
      const other = card && counted.get(card.id);
      if (!other) continue;
      const amount = formatCurrencyCents(Math.abs(other.side.amountCents));
      candidates.push({
        // The same shape of key the amount-and-date rule gives this pair, so an
        // answer recorded before the link was known still stands.
        key: `bill_vs_card:${bill.billId}:${other.side.ids[0]}`,
        kind: "bill_vs_card",
        amountCents: other.side.amountCents,
        matched: [billSide(bill)],
        duplicate: other.side,
        daysApart: daysBetween(other.side.date, bill.date),
        reason:
          `Ramp records this charge as the payment for this bill: the card charge "${other.side.name}" of ${amount} ` +
          `on ${other.side.date} paid the ${bill.merchantName} bill of ${bill.date}. ` +
          `The bill is the expense, so counting the charge as well counts it twice.` +
          (other.reversal ? ` The charge was refunded on ${other.reversal.date}, so it has already been undone.` : ""),
        periodEnd: monthEnd(other.side.date),
        evidence: "ramp_link",
        ...(other.reversal ? { reversal: other.reversal } : {}),
      });
    }
  }
  return { candidates, billIds, chargeIds };
}

/**
 * The amount-and-date rule, for everything Ramp has no link for.
 *
 * `linked` fences off what Ramp has already spoken for: a bill with a link is
 * never offered a card charge here, and a linked charge is never offered to a
 * bill. A linked bill can still meet a bank line or an account debit, which
 * would be a second, separate way of paying it twice.
 */
function pairBills(
  bills: Bill[],
  others: Counterpart[],
  windowDays: number,
  linked: { billIds: Set<string>; chargeIds: Set<string> },
): DuplicateCandidate[] {
  const byCents = new Map<number, Counterpart[]>();
  for (const o of others) {
    if (o.kind === "bill_vs_card" && linked.chargeIds.has(o.side.ids[0])) continue;
    const list = byCents.get(o.side.amountCents) ?? [];
    list.push(o);
    byCents.set(o.side.amountCents, list);
  }

  // Every feasible pair first, then the closest ones claim each other. Rent is
  // the same amount every month, and pairing in input order would let June's
  // bill take the payment that sits nearer to July's.
  const feasible: { bill: Bill; other: Counterpart; daysApart: number }[] = [];
  for (const bill of bills) {
    const from = bill.settledDate && bill.settledDate < bill.date ? bill.settledDate : bill.date;
    const to = bill.settledDate && bill.settledDate > bill.date ? bill.settledDate : bill.date;
    // Signed equality: a bill is money out, and a deposit of the same size is
    // not its payment.
    for (const other of byCents.get(bill.amountCents) ?? []) {
      if (other.kind === "bill_vs_card" && linked.billIds.has(bill.billId)) continue;
      if (distanceToRange(other.side.date, from, to) > windowDays) continue;
      feasible.push({ bill, other, daysApart: daysBetween(other.side.date, bill.date) });
    }
  }
  feasible.sort(
    (a, b) =>
      a.daysApart - b.daysApart ||
      a.bill.billId.localeCompare(b.bill.billId) ||
      a.other.side.ids[0].localeCompare(b.other.side.ids[0]),
  );

  // A bill can be doubled once per kind (a card charge AND a bank line would be
  // two separate mistakes), but one payment row answers to one bill.
  const billTaken = new Set<string>();
  const otherTaken = new Set<string>();
  const out: DuplicateCandidate[] = [];
  for (const { bill, other, daysApart } of feasible) {
    const billKey = `${other.kind}:${bill.billId}`;
    const otherKey = `${other.side.table}:${other.side.ids[0]}`;
    if (billTaken.has(billKey) || otherTaken.has(otherKey)) continue;
    billTaken.add(billKey);
    otherTaken.add(otherKey);

    const amount = formatCurrencyCents(Math.abs(bill.amountCents));
    out.push({
      key: `${other.kind}:${bill.billId}:${other.side.ids[0]}`,
      kind: other.kind,
      amountCents: bill.amountCents,
      matched: [billSide(bill)],
      duplicate: other.side,
      daysApart,
      reason:
        `${other.side.what} "${other.side.name}" on ${other.side.date} is the same ${amount} as the ` +
        `${bill.merchantName} bill of ${bill.date}` +
        (daysApart === 0 ? ", on the same day." : `, ${daysApart} day${daysApart === 1 ? "" : "s"} apart.`) +
        (other.reversal ? ` The charge was refunded on ${other.reversal.date}, so it has already been undone.` : ""),
      periodEnd: monthEnd(other.side.date),
      ...(other.reversal ? { reversal: other.reversal } : {}),
    });
  }
  return out;
}

/**
 * One order billed twice: two bills from the same vendor with the same line
 * items, a few days apart.
 *
 * Every other check here compares a bill with its PAYMENT, so two copies of the
 * bill itself went unseen. October 2026 had two RahrBSG bills of $295.83 with
 * identical lines eight days apart, and nothing asked about them.
 *
 * Same vendor, identical lines and a short window, all three: a same-total bill
 * with different lines is a different order, and an identical bill a month
 * later is rent. It still only asks. Two real orders of the same hops a week
 * apart is a perfectly good answer.
 */
function pairRepeatedBills(bills: Bill[]): DuplicateCandidate[] {
  const signature = (b: Bill) => `${b.merchantName}|${[...b.lineAmounts].sort((x, y) => x - y).join(",")}`;
  const groups = new Map<string, Bill[]>();
  for (const b of bills) {
    const list = groups.get(signature(b)) ?? [];
    list.push(b);
    groups.set(signature(b), list);
  }

  const out: DuplicateCandidate[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date) || a.billId.localeCompare(b.billId));
    // Each bill is asked about once, against the one before it. Three copies
    // make two questions, not three.
    for (let i = 1; i < sorted.length; i++) {
      const earlier = sorted[i - 1];
      const later = sorted[i];
      const daysApart = daysBetween(earlier.date, later.date);
      if (daysApart > BILL_REPEAT_WINDOW_DAYS) continue;
      const amount = formatCurrencyCents(Math.abs(later.amountCents));
      out.push({
        key: `bill_vs_bill:${earlier.billId}:${later.billId}`,
        kind: "bill_vs_bill",
        amountCents: later.amountCents,
        matched: [billSide(earlier)],
        duplicate: billSide(later),
        daysApart,
        reason:
          `Two ${later.merchantName} bills for ${amount} with the same line items, dated ${earlier.date} and ${later.date}` +
          (daysApart === 0 ? ", the same day." : `, ${daysApart} day${daysApart === 1 ? "" : "s"} apart.`) +
          ` If this was one order billed twice, the second is a duplicate. Two separate orders is not.`,
        periodEnd: monthEnd(later.date),
      });
    }
  }
  return out;
}

// ── manual entries ──────────────────────────────────────────────────────────

/** The smallest set of `pool` rows (at most `maxParts`) summing exactly to `target`, or null. */
function exactSubset(pool: DuplicateSide[], target: number, maxParts: number): DuplicateSide[] | null {
  for (let size = 1; size <= maxParts; size++) {
    const found = search(pool, target, size, 0);
    if (found) return found;
  }
  return null;
}

function search(pool: DuplicateSide[], remaining: number, size: number, from: number): DuplicateSide[] | null {
  if (size === 0) return remaining === 0 ? [] : null;
  for (let i = from; i <= pool.length - size; i++) {
    const rest = search(pool, remaining - pool[i].amountCents, size - 1, i + 1);
    if (rest) return [pool[i], ...rest];
  }
  return null;
}

/**
 * A manual entry that restates money the feeds already carry.
 *
 * The feed side is dated by when CASH moved — a bill by the day it was paid,
 * not the day it was issued — because that is what the person writing the
 * entry was looking at: a debit on a statement. And it may be a NET figure.
 * The one found in September was a $1,767.04 bill less a $33.16 interest
 * credit that landed the same day, entered as a single $1,733.88 "missing"
 * debit; no single feed row had that amount.
 */
function pairManualEntries(inputs: DuplicateInputs, bills: Bill[]): DuplicateCandidate[] {
  const pool: DuplicateSide[] = [
    ...bills.map((b) => ({ ...billSide(b), date: b.settledDate ?? b.date })),
    ...inputs.expenses
      .filter((e) => !e.excluded && e.accountingDate && e.state !== "DECLINED")
      .map((e): DuplicateSide => ({
        table: "expenses",
        ids: [e.id],
        what: e.rampObject === "card" ? "Card charge" : "Ramp account debit",
        name: e.merchantName ?? "Unnamed merchant",
        date: e.accountingDate as string,
        amountCents: e.amountCents,
      })),
    ...inputs.bankLines.map((b): DuplicateSide => ({
      table: "bank_ledger",
      ids: [b.id],
      what: b.source === "plaid" ? "Chase bank line" : "Ramp account line",
      name: b.name ?? "Unnamed bank line",
      date: b.transactionDate,
      amountCents: b.amountCents,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.ids[0].localeCompare(b.ids[0]));

  const out: DuplicateCandidate[] = [];
  for (const entry of inputs.manualFlows) {
    if (entry.amountCents === 0) continue;
    if (daysBetween(entry.startDate, entry.endDate) > MANUAL_MAX_SPAN_DAYS) continue;

    const nearby = pool.filter((p) => distanceToRange(p.date, entry.startDate, entry.endDate) <= MANUAL_WINDOW_DAYS);
    const parts = exactSubset(nearby, entry.amountCents, MANUAL_MAX_PARTS);
    if (!parts) continue;

    const name = entry.label?.trim() || "Unlabelled manual entry";
    const amount = formatCurrencyCents(Math.abs(entry.amountCents));
    const described = parts
      .map((p) => `${p.what.toLowerCase()} "${p.name}" (${formatCurrencyCents(p.amountCents)}, ${p.date})`)
      .join(parts.length === 2 ? " and " : ", ");
    out.push({
      key: `manual_vs_feed:${entry.id}:${parts.map((p) => p.ids[0]).sort().join("+")}`,
      kind: "manual_vs_feed",
      amountCents: entry.amountCents,
      matched: parts,
      duplicate: {
        table: "manual_entries",
        ids: [entry.id],
        what: "Manual entry",
        name,
        date: entry.startDate,
        amountCents: entry.amountCents,
      },
      daysApart: Math.max(...parts.map((p) => distanceToRange(p.date, entry.startDate, entry.endDate))),
      reason:
        parts.length === 1
          ? `Manual entry "${name}" (${amount}) is the same amount as the ${described}.`
          : `Manual entry "${name}" (${amount}) is exactly the net of the ${described}.`,
      periodEnd: monthEnd(entry.startDate),
    });
  }
  return out;
}

// ── entry point ─────────────────────────────────────────────────────────────

/** Every pair of records that look like one transaction counted twice, oldest first. */
export function findDuplicateCandidates(
  inputs: DuplicateInputs,
  opts: { windowDays?: number } = {},
): DuplicateCandidate[] {
  const bills = groupBills(inputs.billLines);
  const others = counterparts(inputs);
  const linked = rampLinkedPairs(inputs, bills, others);
  return [
    ...linked.candidates,
    ...pairBills(bills, others, opts.windowDays ?? DEFAULT_WINDOW_DAYS, linked),
    ...pairManualEntries(inputs, bills),
    ...pairRepeatedBills(bills),
  ].sort((a, b) => a.duplicate.date.localeCompare(b.duplicate.date) || a.key.localeCompare(b.key));
}
