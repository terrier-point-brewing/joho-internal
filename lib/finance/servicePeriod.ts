/**
 * Service periods: a bill that pays for more than the month it arrived in.
 *
 * A yearly property-tax bill, an annual insurance premium, a twelve-month
 * software licence — each lands as ONE expense on ONE date, and left alone the
 * P&L charges the whole thing to that month. Tagging the expense with the
 * months it covers (`expense_service_periods`) makes every statement read it
 * the way the business consumes it: an equal share per month covered.
 *
 * ── The one rule: nothing is recognised before the bill exists ───────────────
 * A service month earlier than the bill's own month folds into the bill's
 * month, as a catch-up. Later service months are deferred and recognised one
 * by one. So a 2026 bill dated 2 November books January–November in November
 * and December in December.
 *
 * Booking the earlier months where they "belong" would restate months that
 * have already been reported — and usually closed — on the strength of a
 * document that did not exist yet. It would also make a month's figure depend
 * on a bill dated after it, which the from-inception retained-earnings scan
 * (it stops at period end) could not see. The catch-up keeps every statement
 * deterministic from recorded history: asking about October never needs
 * November's paperwork.
 *
 * ── Equal months, not equal days ─────────────────────────────────────────────
 * Each fully covered month takes the same share, so a twelve-month bill is
 * twelve equal charges rather than a February that reads 10% cheaper than
 * March. A partly covered month — a period starting on the 15th — is weighted
 * by the fraction of that month it covers.
 *
 * ── One formula, three readers ───────────────────────────────────────────────
 * aggregateRows (the P&L, and therefore retained earnings), the Prepaid
 * Expenses balance provider and the forecast all call `recognitionByMonth`.
 * What the P&L has not yet recognised is by construction what the balance
 * sheet still carries as prepaid.
 *
 * Pure: no database, no React. Must not import from lib/finance/balances
 * (statement isolation — aggregateRows imports this).
 */

/** `FinancialsRow.sourceRef.table` for a row made of spread bills. Also the table name. */
export const SERVICE_PERIOD_TABLE = "expense_service_periods";

/** Inclusive on both ends, "YYYY-MM-DD". */
export interface ServicePeriod {
  start: string;
  end: string;
}

export interface MonthAllocation {
  monthKey: string; // "YYYY-MM"
  amountCents: number;
}

/** Statement sections whose postings are income or cost. A split line coded to a balance-sheet account is never spread. */
const PL_SECTIONS: ReadonlySet<string> = new Set(["revenue", "cogs", "expenses", "other_income", "other_expense"]);

export function isSpreadableSection(section: string): boolean {
  return PL_SECTIONS.has(section);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Ten years. Longer than that is an asset to depreciate, or a typo in the year. */
const MAX_PERIOD_MONTHS = 120;

function parts(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isRealDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const { y, m, d } = parts(date);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function monthKey(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * Each month the period touches, with the fraction of that month it covers
 * (1 for a fully covered month). Ascending.
 */
export function serviceMonthWeights(period: ServicePeriod): { monthKey: string; weight: number }[] {
  const start = parts(period.start);
  const end = parts(period.end);
  const out: { monthKey: string; weight: number }[] = [];
  for (let y = start.y, m = start.m; y < end.y || (y === end.y && m <= end.m); ) {
    const days = daysInMonth(y, m);
    const from = y === start.y && m === start.m ? start.d : 1;
    const to = y === end.y && m === end.m ? end.d : days;
    out.push({ monthKey: monthKey(y, m), weight: (to - from + 1) / days });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export type ServicePeriodValidation = { ok: true } | { ok: false; error: string };

export function validateServicePeriod(period: { start?: unknown; end?: unknown }): ServicePeriodValidation {
  const { start, end } = period;
  if (typeof start !== "string" || typeof end !== "string" || !isRealDate(start) || !isRealDate(end)) {
    return { ok: false, error: "Enter the first and last day this bill covers" };
  }
  if (start > end) return { ok: false, error: "The last day covered is before the first" };
  const months = serviceMonthWeights({ start, end }).length;
  if (months < 2) return { ok: false, error: "A bill that covers a single month needs no spreading" };
  if (months > MAX_PERIOD_MONTHS) return { ok: false, error: "A bill can be spread over ten years at most" };
  return { ok: true };
}

/**
 * `amountCents` shared over the period's months by weight. Sign is preserved
 * and the parts always sum exactly to the input (largest-remainder rounding,
 * the same technique as prorateAcrossMonths).
 */
export function spreadOverServicePeriod(amountCents: number, period: ServicePeriod): MonthAllocation[] {
  const weights = serviceMonthWeights(period);
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  if (weights.length === 0 || total <= 0) return [];

  const lines = weights.map((w) => {
    const raw = (amountCents * w.weight) / total;
    const truncated = Math.trunc(raw);
    return { monthKey: w.monthKey, amountCents: truncated, remainder: Math.abs(raw - truncated) };
  });
  let remaining = amountCents - lines.reduce((sum, l) => sum + l.amountCents, 0);
  const step = Math.sign(remaining);
  const order = [...lines.keys()].sort((a, b) => lines[b].remainder - lines[a].remainder);
  for (const idx of order) {
    if (remaining === 0) break;
    lines[idx].amountCents += step;
    remaining -= step;
  }
  return lines.map((l) => ({ monthKey: l.monthKey, amountCents: l.amountCents }));
}

/**
 * When each cent of a spread bill reaches the P&L: the period's own months,
 * with everything earlier than `billMonth` folded into `billMonth`. Ascending,
 * zero-amount months omitted, parts sum exactly to `amountCents`.
 */
export function recognitionByMonth(amountCents: number, period: ServicePeriod, billMonth: string): MonthAllocation[] {
  const byMonth = new Map<string, number>();
  for (const alloc of spreadOverServicePeriod(amountCents, period)) {
    const key = alloc.monthKey < billMonth ? billMonth : alloc.monthKey;
    byMonth.set(key, (byMonth.get(key) ?? 0) + alloc.amountCents);
  }
  return [...byMonth.entries()]
    .filter(([, cents]) => cents !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, cents]) => ({ monthKey: key, amountCents: cents }));
}

/** The part of a spread bill the P&L has NOT recognised by the end of `throughMonth` — what is still prepaid. Same sign as the input. */
export function deferredAfter(amountCents: number, period: ServicePeriod, billMonth: string, throughMonth: string): number {
  return recognitionByMonth(amountCents, period, billMonth)
    .filter((alloc) => alloc.monthKey > throughMonth)
    .reduce((sum, alloc) => sum + alloc.amountCents, 0);
}

/** What one fully covered month costs: the bill over its total month-weight. Unrounded. */
export function fullMonthRateCents(amountCents: number, period: ServicePeriod): number {
  const total = serviceMonthWeights(period).reduce((sum, w) => sum + w.weight, 0);
  return total > 0 ? amountCents / total : 0;
}

/** How many months the period runs, rounded to whole months and at least one — the interval a renewal recurs at. */
export function servicePeriodMonths(period: ServicePeriod): number {
  const total = serviceMonthWeights(period).reduce((sum, w) => sum + w.weight, 0);
  return Math.max(1, Math.round(total));
}
