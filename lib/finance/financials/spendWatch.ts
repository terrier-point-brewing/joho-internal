// Spend Watch: which expense accounts moved this month, against what they
// usually cost. Pure functions over an already-built statement
// (FinancialsRow[] + months), so the Financials page can run it over either
// the P&L (accrual) or the cash-flow rows without a new query.
//
// Design choices, each a response to a real false alarm:
//
//   * Baseline = trailing average of the prior months, not last month. Rent on
//     a cash basis is 0 / 6,690 / 13,380 month to month because bills settle
//     in the first week of the following month; against last month that
//     flags every month, against a 3-month average it flags rarely.
//   * Flag on dollars AND percent. A 40% jump in a $50 account must not
//     outrank a 10% jump in payroll, and a 15% move on a $20 account is noise.
//   * Magnitudes, not signed cents. FinancialsRow carries cost sections as
//     NEGATIVE cents (normalizeSign.ts). Spend is reported as a positive
//     number so "up" means spending more, which is what the reader asks.

import type { CoaAccountRef, FinancialsRow } from "./types";

/** The cost side of the P&L. Revenue is deliberately out of scope: this view answers "where is money going", not "how are sales". */
export const SPEND_SECTIONS: ReadonlySet<string> = new Set(["cogs", "expenses", "other_expense"]);

export type MoverKind = "up" | "down" | "new" | "stopped";

export interface SpendMover {
  coaId: string;
  /** Full account name as the chart stores it, e.g. "OPERATING EXPENSES:Facilities & Occupancy:Building & Land Rent". */
  accountName: string;
  /** Last ":"-segment of accountName. */
  shortName: string;
  /** The segment before shortName, when there is one — the grouping the reader knows the account by. */
  groupName: string | null;
  accountNumber: string | null;
  statementSection: string;
  /** Spend in the focus month, POSITIVE cents (a net credit month reads negative). */
  focusCents: number;
  /** Average spend over `baselineMonths`, POSITIVE cents. 0 when there are no baseline months. */
  baselineCents: number;
  /** focusCents - baselineCents. Positive = spending more. */
  deltaCents: number;
  /** deltaCents / baselineCents × 100, or null when the baseline is 0 (nothing to be a percentage of). */
  deltaPct: number | null;
  kind: MoverKind;
  /** Whether this mover clears the dollar-and-percent thresholds. The caller shows flagged rows first, the rest on request. */
  flagged: boolean;
}

export interface SpendWatchOptions {
  /** How many months before the focus month form the baseline. Default 3. */
  baselineMonths?: number;
  /** Minimum |delta| to flag, cents. Default $250. */
  minDeltaCents?: number;
  /** Minimum |delta| as a percent of the baseline to flag. Ignored when baseline is 0. Default 15. */
  minDeltaPct?: number;
  /** Chart reference so an account's number and canonical name come from the chart, not from whichever row happened to be first. */
  coaAccounts?: CoaAccountRef[];
}

export interface SpendWatchResult {
  focusMonth: string;
  /** The months the baseline averages over, ascending. Empty when the focus month is the first month. */
  baselineMonths: string[];
  /** Every spend account with any activity in focus or baseline months, sorted flagged-first then by |delta| desc. */
  movers: SpendMover[];
  /** Sum of focusCents across all spend accounts. */
  totalFocusCents: number;
  /** Sum of baselineCents across all spend accounts. */
  totalBaselineCents: number;
  /** Accounts with spend in the focus month and none in any baseline month (requires ≥1 baseline month). */
  newSpend: SpendMover[];
}

const DEFAULTS = { baselineMonths: 3, minDeltaCents: 25_000, minDeltaPct: 15 };

/**
 * Which month to open on. The current month is partial, so comparing it to
 * full months would show every account "down"; default to the last ENDED
 * month when there is one. `openMonth` is "YYYY-MM" of today in the brewery's
 * zone.
 */
export function defaultFocusMonth(months: string[], openMonth: string): string | null {
  if (months.length === 0) return null;
  const last = months[months.length - 1];
  if (last === openMonth && months.length >= 2) return months[months.length - 2];
  return last;
}

/** The up-to-N months immediately before `focusMonth` within `months`, ascending. */
export function baselineMonthsFor(months: string[], focusMonth: string, count: number): string[] {
  const idx = months.indexOf(focusMonth);
  if (idx <= 0) return [];
  return months.slice(Math.max(0, idx - count), idx);
}

function splitName(name: string): { shortName: string; groupName: string | null } {
  const parts = name.split(":").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { shortName: name, groupName: null };
  return { shortName: parts[parts.length - 1], groupName: parts.length >= 2 ? parts[parts.length - 2] : null };
}

export function buildSpendWatch(
  rows: FinancialsRow[],
  months: string[],
  focusMonth: string,
  opts: SpendWatchOptions = {},
): SpendWatchResult {
  const baselineN = opts.baselineMonths ?? DEFAULTS.baselineMonths;
  const minDelta = opts.minDeltaCents ?? DEFAULTS.minDeltaCents;
  const minPct = opts.minDeltaPct ?? DEFAULTS.minDeltaPct;
  const coaById = new Map((opts.coaAccounts ?? []).map((c) => [c.id, c]));

  const baseline = baselineMonthsFor(months, focusMonth, baselineN);

  // Aggregate by account across channel/category slices and manual
  // adjustments (which share the real account's coaId). Unmapped rows have
  // no account to watch; the data-quality panel owns those.
  const byAccount = new Map<string, { name: string; section: string; focus: number; base: number }>();
  for (const r of rows) {
    if (r.coaId === null || !SPEND_SECTIONS.has(r.statementSection)) continue;
    const acc = byAccount.get(r.coaId) ?? { name: r.accountName, section: r.statementSection, focus: 0, base: 0 };
    // Costs are negative cents; negate so spend reads positive.
    acc.focus += -(r.amountCentsByMonth[focusMonth] ?? 0);
    for (const m of baseline) acc.base += -(r.amountCentsByMonth[m] ?? 0);
    byAccount.set(r.coaId, acc);
  }

  const movers: SpendMover[] = [];
  let totalFocus = 0;
  let totalBaseline = 0;

  for (const [coaId, acc] of byAccount) {
    const baselineCents = baseline.length > 0 ? Math.round(acc.base / baseline.length) : 0;
    const focusCents = acc.focus;
    if (focusCents === 0 && baselineCents === 0) continue;

    totalFocus += focusCents;
    totalBaseline += baselineCents;

    const deltaCents = focusCents - baselineCents;
    const deltaPct = baselineCents !== 0 ? (deltaCents / Math.abs(baselineCents)) * 100 : null;

    let kind: MoverKind;
    if (baseline.length > 0 && baselineCents === 0 && focusCents > 0) kind = "new";
    else if (focusCents === 0 && baselineCents > 0) kind = "stopped";
    else kind = deltaCents >= 0 ? "up" : "down";

    const clearsDollars = Math.abs(deltaCents) >= minDelta;
    const clearsPct = deltaPct === null || Math.abs(deltaPct) >= minPct;
    const flagged = clearsDollars && clearsPct;

    const chart = coaById.get(coaId);
    const accountName = chart?.accountName ?? acc.name;
    const { shortName, groupName } = splitName(accountName);

    movers.push({
      coaId,
      accountName,
      shortName,
      groupName,
      accountNumber: chart?.accountNumber ?? null,
      statementSection: acc.section,
      focusCents,
      baselineCents,
      deltaCents,
      deltaPct,
      kind,
      flagged,
    });
  }

  movers.sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    return Math.abs(b.deltaCents) - Math.abs(a.deltaCents);
  });

  return {
    focusMonth,
    baselineMonths: baseline,
    movers,
    totalFocusCents: totalFocus,
    totalBaselineCents: totalBaseline,
    newSpend: movers.filter((m) => m.kind === "new"),
  };
}
