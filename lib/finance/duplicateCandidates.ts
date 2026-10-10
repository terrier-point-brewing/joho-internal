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
 * ── What this does not do ────────────────────────────────────────────────────
 * It proposes; it never sets anything aside. A candidate is a question for a
 * person ("is this one payment?"), and the answer is recorded elsewhere so the
 * question is not asked twice.
 *
 * Pure: the caller supplies already-fetched rows.
 */
import { formatCurrencyCents } from "@/lib/format";
import { monthEnd } from "@/lib/finance/manualEntries";

export type DuplicateKind = "bill_vs_card" | "bill_vs_ramp_debit" | "bill_vs_bank_line" | "manual_vs_feed";

/** How far either side of a bill's own dates its payment may sit and still be the same money. */
export const DEFAULT_WINDOW_DAYS = 7;

/**
 * How far a manual entry's dates may sit from the feed rows it restates. Tight
 * on purpose: a hand entry for "the debit on June 1" names its day, and every
 * extra day in the pool multiplies the combinations that can sum to it by luck.
 */
export const MANUAL_WINDOW_DAYS = 1;

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
}

/** One `expenses` row with ramp_object = 'card' or 'bank'. */
export interface ExpenseInput {
  id: string;
  rampObject: "card" | "bank";
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
  /** Month end of the duplicate's date: the month whose expense is doubled. */
  periodEnd: string;
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
  merchantName: string;
  /** The day it was incurred. */
  date: string;
  /** The UTC day it was paid, the same boundary the cash-flow statement uses. */
  settledDate: string | null;
  amountCents: number;
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
        merchantName: line.merchantName ?? "Unnamed vendor",
        date: line.accountingDate,
        settledDate: line.settledAt ? line.settledAt.slice(0, 10) : null,
        amountCents: line.amountCents,
      });
      continue;
    }
    bill.lineIds.push(line.id);
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
  kind: Exclude<DuplicateKind, "manual_vs_feed">;
  side: DuplicateSide;
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
  for (const e of inputs.expenses) {
    if (e.excluded || !e.accountingDate || e.state === "DECLINED") continue;
    out.push({
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

function pairBills(bills: Bill[], others: Counterpart[], windowDays: number): DuplicateCandidate[] {
  const byCents = new Map<number, Counterpart[]>();
  for (const o of others) {
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
        (daysApart === 0 ? ", on the same day." : `, ${daysApart} day${daysApart === 1 ? "" : "s"} apart.`),
      periodEnd: monthEnd(other.side.date),
    });
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
  return [
    ...pairBills(bills, counterparts(inputs), opts.windowDays ?? DEFAULT_WINDOW_DAYS),
    ...pairManualEntries(inputs, bills),
  ].sort((a, b) => a.duplicate.date.localeCompare(b.duplicate.date) || a.key.localeCompare(b.key));
}
