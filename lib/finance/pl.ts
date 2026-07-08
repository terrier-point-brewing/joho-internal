/**
 * Pure P&L assembly math — the seam where revenue (derived from INTEGER-CENTS
 * columns) meets COGS and operating expenses (DECIMAL-DOLLAR values) to produce
 * gross profit and operating income.
 *
 * The ÷100 that converts cents→dollars lives HERE, in one place, so the route
 * hands over raw cents (taproom net sales, invoice totals, manual entries) and
 * raw dollars (ingredient/packaging cost, Ramp expenses) and can't
 * accidentally double-convert or skip a conversion at the boundary.
 */

/** Round a dollar amount to whole cents (half away from zero for positives). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A manual net-sales entry: an amount in INTEGER CENTS over a date span. */
export interface ManualNetSalesEntry {
  start_date: string; // YYYY-MM-DD
  end_date: string;   // YYYY-MM-DD
  amount_cents: number;
}

/**
 * Prorate manual net-sales entries onto the [from, to] reporting window and
 * return the total in DOLLARS. Each entry's cents amount is split evenly across
 * its own day span and only the overlapping days are counted. The ÷100 happens
 * per entry (matching the route's historical rounding) so callers get dollars.
 */
export function proratedManualRevenue(
  entries: readonly ManualNetSalesEntry[],
  from: string,
  to: string
): number {
  const startDate = new Date(from + "T00:00:00");
  const endDate = new Date(to + "T00:00:00");
  let manualRevenue = 0;
  for (const entry of entries) {
    const eStart = new Date(entry.start_date + "T00:00:00");
    const eEnd = new Date(entry.end_date + "T00:00:00");
    const oStart = startDate > eStart ? startDate : eStart;
    const oEnd = endDate < eEnd ? endDate : eEnd;
    if (oStart <= oEnd) {
      const eDays = Math.round((eEnd.getTime() - eStart.getTime()) / 86_400_000) + 1;
      const oDays = Math.round((oEnd.getTime() - oStart.getTime()) / 86_400_000) + 1;
      manualRevenue += Math.round((entry.amount_cents * oDays) / eDays) / 100;
    }
  }
  return manualRevenue;
}

/** Raw-unit inputs to the P&L summary. Cents where the column is cents; dollars where it is dollars. */
export interface PlSummaryInputs {
  /** Taproom net sales, INTEGER CENTS. */
  taproomNetSalesCents: number;
  /** Sum of completed invoice-order totals, INTEGER CENTS. */
  invoiceTotalCents: number;
  /** Prorated manual revenue, already in DOLLARS (see proratedManualRevenue). */
  manualRevenueDollars: number;
  /** Ingredient COGS, DOLLARS. */
  ingredientCostDollars: number;
  /** Packaging COGS, DOLLARS. */
  packagingCostDollars: number;
  /** Operating (Ramp) expenses, DOLLARS. */
  operatingExpensesDollars: number;
}

export interface PlSummary {
  revenue: { taproom: number; invoices: number; manual: number; total: number };
  cogs: { ingredients: number; packaging: number; total: number };
  grossProfit: number;
  operatingExpenses: number;
  operatingIncome: number;
}

/**
 * Combine cents-derived revenue with dollar-denominated COGS and expenses into a
 * rounded P&L summary. All monetary outputs are DOLLARS rounded to cents.
 */
export function computePlSummary(inputs: PlSummaryInputs): PlSummary {
  const taproom = inputs.taproomNetSalesCents / 100;
  const invoices = inputs.invoiceTotalCents / 100;
  const manual = inputs.manualRevenueDollars;
  const totalRevenue = taproom + invoices + manual;

  const totalCogs = inputs.ingredientCostDollars + inputs.packagingCostDollars;
  const grossProfit = totalRevenue - totalCogs;
  const operatingIncome = grossProfit - inputs.operatingExpensesDollars;

  return {
    revenue: {
      taproom: round2(taproom),
      invoices: round2(invoices),
      manual: round2(manual),
      total: round2(totalRevenue),
    },
    cogs: {
      ingredients: round2(inputs.ingredientCostDollars),
      packaging: round2(inputs.packagingCostDollars),
      total: round2(totalCogs),
    },
    grossProfit: round2(grossProfit),
    operatingExpenses: round2(inputs.operatingExpensesDollars),
    operatingIncome: round2(operatingIncome),
  };
}
