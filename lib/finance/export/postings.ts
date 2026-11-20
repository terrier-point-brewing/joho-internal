// The P&L, taken apart into the individual postings it is made of.
//
// A statement row is a (source, account, channel, ...) group summed by month.
// A bookkeeper needs the lines underneath: which sale, bill or bank movement
// put how much on which account in which month.
//
// ── Why this calls aggregateRows once per record ────────────────────────────
// The rules that turn a source record into a posting -- which account it
// resolves to, its sign, how a payroll withdrawal is split across accounts and
// prorated across the months its pay period spans -- live in aggregateRows.ts,
// which is one of the verified P&L modules (scripts/check-statement-isolation
// .mjs) and is not to be edited for an export. Re-implementing those rules
// here would produce a second opinion that drifts from the statement the first
// time either side changes.
//
// So nothing is re-implemented. aggregateRows is a pure function; handing it a
// single record returns exactly the posting(s) that record contributes. The
// detail is the statement's own arithmetic, one record at a time, and
// reconcileToStatement() below proves the two agree rather than assuming it.
//
// Pure: no DB, no clock.

import { aggregateRows } from "@/lib/finance/financials/aggregateRows";
import type {
  AggregateRowsInput,
  BankLedgerRecord,
  CoaRecord,
  ExpenseRecord,
  InvoiceLineRecord,
  PosLineRecord,
  RefundRecord,
} from "@/lib/finance/financials/aggregateRows";
import type { FinancialsRow, MappingSource } from "@/lib/finance/financials/types";

export type PostingSource = "pos_line_items" | "invoice_line_items" | "expenses" | "bank_ledger" | "square_refunds";

export interface Posting {
  source: PostingSource;
  /** The source row's id (for a refund split by line, the refund_lines id). */
  recordId: string;
  /** null = unmapped. */
  coaId: string | null;
  /** "YYYY-MM" the amount lands in on the statement. Differs from `date` only for a payroll withdrawal prorated over its pay period. */
  month: string;
  /** Statement-convention cents: income positive, cost negative. */
  amountCents: number;
  /** The record's own date, "YYYY-MM-DD". */
  date: string;
  mappingSource: MappingSource;
  channel: string;
}

export interface PostingSources {
  pos: PosLineRecord[];
  invoiceLines: InvoiceLineRecord[];
  expenses: ExpenseRecord[];
  bank: BankLedgerRecord[];
  refunds: RefundRecord[];
  coa: CoaRecord[];
}

const EMPTY: Omit<AggregateRowsInput, "coa" | "months"> = {
  pos: [],
  invoiceLines: [],
  expenses: [],
  refunds: [],
  bank: [],
  tipAccruals: [],
  taxAccruals: [],
};

function day(value: string | null | undefined): string {
  return (value ?? "").slice(0, 10);
}

/** Every posting the source records contribute to `months`, in source order. */
export function resolvePostings(src: PostingSources, months: string[]): Posting[] {
  const out: Posting[] = [];

  const emit = (source: PostingSource, recordId: string, date: string, input: Partial<AggregateRowsInput>) => {
    const rows = aggregateRows({ ...EMPTY, ...input, coa: src.coa, months });
    for (const row of rows) {
      for (const month of months) {
        const amountCents = row.amountCentsByMonth[month] ?? 0;
        if (amountCents === 0) continue;
        out.push({ source, recordId, coaId: row.coaId, month, amountCents, date, mappingSource: row.mappingSource, channel: row.channel });
      }
    }
  };

  for (const r of src.pos) emit("pos_line_items", r.id, day(r.transactionDate), { pos: [r] });
  for (const r of src.invoiceLines) emit("invoice_line_items", r.id, day(r.invoiceDate), { invoiceLines: [r] });
  for (const r of src.expenses) emit("expenses", r.id, day(r.accountingDate), { expenses: [r] });
  for (const r of src.bank) emit("bank_ledger", r.id, day(r.transactionDate), { bank: [r] });
  for (const r of src.refunds) emit("square_refunds", r.id, day(r.refundedAt), { refunds: [r] });

  return out;
}

// ── derived lines ───────────────────────────────────────────────────────────

/**
 * A statement line no single transaction produced: depreciation, inventory
 * capitalisation and relief, cost of beer sold, excise accrued, card
 * processing fees, and operator-entered manual entries. One per account per
 * month, because that is the grain they are computed at.
 */
export interface DerivedLine {
  coaId: string;
  month: string;
  amountCents: number;
  /** The statement row's own name, e.g. "Depreciation Expense (Depreciation)". */
  description: string;
  /** What computed it -- the statement row's sourceRef.table. */
  basis: string;
}

/**
 * Whether a statement row was synthesized by one of buildFinancials' inject*
 * steps rather than aggregated from source records.
 *
 * Every injector names its row "<account name> <suffix>" (or a fallback name
 * when the account is missing), where an aggregated row is named exactly its
 * account. sourceRef.table cannot be the test: the inventory capitalisation
 * row reports "expenses", the same table real expense rows do. If an injector
 * ever stops suffixing, reconcileToStatement reports the difference instead of
 * the export silently mislabelling it.
 */
export function isDerivedRow(row: FinancialsRow, coaNameById: Map<string, string>): boolean {
  if (row.coaId === null) return false;
  return row.accountName !== coaNameById.get(row.coaId);
}

export function derivedLines(rows: FinancialsRow[], months: string[], coa: CoaRecord[]): DerivedLine[] {
  const names = new Map(coa.map((c) => [c.id, c.accountName]));
  const out: DerivedLine[] = [];
  for (const row of rows) {
    if (!isDerivedRow(row, names) || row.coaId === null) continue;
    for (const month of months) {
      const amountCents = row.amountCentsByMonth[month] ?? 0;
      if (amountCents === 0) continue;
      out.push({ coaId: row.coaId, month, amountCents, description: row.accountName, basis: row.sourceRef.table });
    }
  }
  return out;
}

// ── the proof ───────────────────────────────────────────────────────────────

export interface TieDifference {
  coaId: string | null;
  month: string;
  statementCents: number;
  detailCents: number;
}

const UNMAPPED_KEY = "\0unmapped";

/**
 * Compares the detail (postings + derived lines) against the statement rows,
 * account by account, month by month. An empty result means every figure on
 * the P&L is fully accounted for by the lines listed under it.
 */
export function reconcileToStatement(
  rows: FinancialsRow[],
  postings: Posting[],
  derived: DerivedLine[],
  months: string[],
): TieDifference[] {
  const key = (coaId: string | null, month: string) => `${coaId ?? UNMAPPED_KEY}|${month}`;
  const statement = new Map<string, number>();
  const detail = new Map<string, number>();
  const add = (map: Map<string, number>, k: string, cents: number) => map.set(k, (map.get(k) ?? 0) + cents);

  for (const row of rows) for (const m of months) add(statement, key(row.coaId, m), row.amountCentsByMonth[m] ?? 0);
  for (const p of postings) add(detail, key(p.coaId, p.month), p.amountCents);
  for (const d of derived) add(detail, key(d.coaId, d.month), d.amountCents);

  const out: TieDifference[] = [];
  for (const k of new Set([...statement.keys(), ...detail.keys()])) {
    const statementCents = statement.get(k) ?? 0;
    const detailCents = detail.get(k) ?? 0;
    if (statementCents === detailCents) continue;
    const [coaKey, month] = k.split("|");
    out.push({ coaId: coaKey === UNMAPPED_KEY ? null : coaKey, month, statementCents, detailCents });
  }
  return out.sort((a, b) => a.month.localeCompare(b.month) || (a.coaId ?? "").localeCompare(b.coaId ?? ""));
}

// ── debit / credit ──────────────────────────────────────────────────────────

const PL_SECTIONS: ReadonlySet<string> = new Set(["revenue", "other_income", "cogs", "expenses", "other_expense"]);

/**
 * Which side of the account a statement-convention amount sits on.
 *
 * The internal convention (normalizeSign.ts) is not a debit/credit convention:
 * income and assets are both positive, costs and liabilities both negative. So
 * the side depends on the kind of account --
 *   P&L account:            positive is a credit (income, or a cost refunded);
 *                           negative is a debit (a cost, or income reversed).
 *   balance-sheet account:  positive is a debit (asset up, liability down);
 *                           negative is a credit.
 * An unmapped line has no account to take a side on; it is treated as P&L,
 * which is what it will be once someone maps it.
 */
export function debitCredit(amountCents: number, statementSection: string): { debitCents: number; creditCents: number } {
  const positiveIsCredit = PL_SECTIONS.has(statementSection) || statementSection === "unmapped";
  const isCredit = positiveIsCredit ? amountCents > 0 : amountCents < 0;
  const magnitude = Math.abs(amountCents);
  return isCredit ? { debitCents: 0, creditCents: magnitude } : { debitCents: magnitude, creditCents: 0 };
}
