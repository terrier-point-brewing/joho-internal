/**
 * Straight-line depreciation over monthly additions, with prospective life
 * revisions. Pure arithmetic — no IO, no Date.now(), fully deterministic from
 * its inputs, which is what lets the P&L, the balance sheet and retained
 * earnings all call it and be guaranteed the same answer.
 *
 * ── Additions, not "an asset" ────────────────────────────────────────────────
 * The unit depreciated is a MONTH'S NET ADDITIONS to a GL account, not an
 * itemised asset register. This business codes an asset purchase to 1520 the
 * month it happens; each month's coded total starts its own straight-line run
 * from that month. A second brewhouse bought next year depreciates from next
 * year automatically, with nobody maintaining a register. The cost of that
 * simplification is that two assets bought the same month share one line —
 * acceptable at this size, and the schedule's life is per ACCOUNT anyway.
 *
 * ── Life changes are prospective. There is deliberately no restating mode ────
 * A change in useful life is a change in accounting estimate, and the standard
 * treatment (ASC 250-10-45-17) is prospective: the remaining book value at the
 * change date spreads over the remaining NEW life, and no prior period is
 * touched. Recomputing history under the new life — the obvious "backfill" —
 * is the treatment reserved for correcting an ERROR, requires restatement
 * disclosures, and would silently rewrite every closed month's P&L here. So a
 * revision carries the month it takes effect and the engine switches rates at
 * that month, which gives an operator the whole intended power of "change the
 * life" with none of the rewriting.
 *
 * ── The declining-remaining formulation ──────────────────────────────────────
 * Each month's charge is round(NBV / months remaining) rather than a fixed
 * basis/life. For a constant life the two are identical to the cent by the end
 * (the final month charges exactly the residual NBV, so rounding can never
 * strand a cent or overshoot), and under a revision it IS the prospective
 * rule — NBV over remaining life — rather than an approximation of it.
 *
 * ── Signs ────────────────────────────────────────────────────────────────────
 * Additions arrive in the balance sheet's internal convention for an asset:
 * positive = more asset. A NEGATIVE addition (a correction or partial disposal
 * coded straight to the account) runs through the same arithmetic and produces
 * negative depreciation from its month — which unwinds expense at the same
 * rate it would have accrued, keeping the account's accumulated depreciation
 * from outliving the asset that earned it. Expense is returned in the P&L's
 * internal convention: a cost, so negative.
 */

/** One month's net additions to a depreciating account. */
export interface Addition {
  /** "YYYY-MM". Depreciation begins this month (full-month convention). */
  month: string;
  /** Internal-convention cents: positive = asset acquired. */
  cents: number;
}

/**
 * A useful life, from a month onward. `effectiveMonth: null` is the life the
 * schedule was created with and applies from inception; every later revision
 * carries the month the operator made the change.
 */
export interface LifeRevision {
  effectiveMonth: string | null;
  lifeMonths: number;
}

export interface DepreciationSeries {
  /**
   * Depreciation EXPENSE per month, internal P&L convention (negative), keyed
   * "YYYY-MM". Months with no charge are absent, not zero.
   */
  expenseCentsByMonth: Record<string, number>;
  /**
   * Accumulated depreciation at the end of `throughMonth`, internal
   * balance-sheet convention for a contra-asset (negative).
   */
  accumulatedCents: number;
}

/** "YYYY-MM" arithmetic without Date objects — no timezone to get wrong. */
function monthIndex(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return y * 12 + (m - 1);
}

function monthFromIndex(index: number): string {
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** The life in force at `month`: the latest revision effective on or before it. */
function lifeAt(revisions: LifeRevision[], month: string): number | null {
  let life: number | null = null;
  for (const r of revisions) {
    if (r.effectiveMonth === null || r.effectiveMonth <= month) life = r.lifeMonths;
  }
  return life;
}

/**
 * Depreciate one account's additions through the end of `throughMonth`.
 *
 * `revisions` must be sorted with the inception life (effectiveMonth null)
 * first and later revisions ascending — the fetch layer's ORDER BY does this;
 * the engine re-sorts defensively because a wrong order here mis-states money.
 * `endedMonth`, when set, is the last month that accrues a charge: the
 * schedule was stopped (asset disposed of, account retired) and accumulated
 * depreciation holds constant from then on rather than vanishing.
 */
export function computeDepreciationSeries(
  additions: Addition[],
  revisions: LifeRevision[],
  throughMonth: string,
  endedMonth?: string | null,
): DepreciationSeries {
  const sorted = [...revisions].sort((a, b) => {
    if (a.effectiveMonth === null) return -1;
    if (b.effectiveMonth === null) return 1;
    return a.effectiveMonth.localeCompare(b.effectiveMonth);
  });

  const lastMonth = endedMonth && endedMonth < throughMonth ? endedMonth : throughMonth;
  const lastIdx = monthIndex(lastMonth);

  const expenseCentsByMonth: Record<string, number> = {};
  let accumulated = 0;

  for (const addition of additions) {
    if (addition.cents === 0) continue;
    const startIdx = monthIndex(addition.month);
    if (startIdx > lastIdx) continue;

    let nbv = addition.cents;
    for (let idx = startIdx; idx <= lastIdx && nbv !== 0; idx++) {
      const month = monthFromIndex(idx);
      const life = lifeAt(sorted, month);
      // No life in force yet: a schedule revised into existence mid-history
      // cannot happen through the API (creation writes the inception life),
      // but a defensive skip beats inventing a rate.
      if (life === null || life <= 0) continue;

      const age = idx - startIdx; // months already charged
      const remaining = life - age;
      // Life shortened to less than the asset's age: the whole remaining book
      // value is charged in the change month — the prospective rule's limit
      // case, not an error.
      // A charge that rounds to zero is genuinely nothing this month — a few
      // cents of NBV over many remaining months. It is not stranded: remaining
      // shrinks every month, and the `remaining <= 1` arm charges whatever is
      // left in the final month exactly.
      const charge = remaining <= 1 ? nbv : Math.round(nbv / remaining);
      nbv -= charge;
      accumulated += charge;
      if (charge !== 0) {
        // Expense is a cost: internal P&L convention negative for a positive charge.
        expenseCentsByMonth[month] = (expenseCentsByMonth[month] ?? 0) - charge;
      }
    }
    // Whatever book value survives past `lastMonth` simply has not been
    // depreciated yet — it is next month's problem, not a remainder to force.
  }

  // `0 + x` normalizes the -0 that negating an empty accumulation produces —
  // Object.is(-0, 0) is false and a -0 leaks into JSON as "-0" in some paths.
  return { expenseCentsByMonth, accumulatedCents: 0 + -accumulated };
}

/** Sum of a series' expense through a month (inclusive), internal convention (negative). */
export function expenseThroughMonth(series: DepreciationSeries, month: string): number {
  let sum = 0;
  for (const [m, cents] of Object.entries(series.expenseCentsByMonth)) {
    if (m <= month) sum += cents;
  }
  return sum;
}
