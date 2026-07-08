/**
 * Pure COGS cost-rollup math for stock and packaging adjustments.
 *
 * Cost columns on `stock_adjustments` / `packaging_stock_adjustments` are stored
 * as DECIMAL DOLLARS (not integer cents): `total_value_change` and
 * `cost_per_unit`. Consumption/waste is recorded as a NEGATIVE value change, so
 * the cost magnitude is always the absolute value.
 *
 * This is the single source of truth for "what did one adjustment cost" — both
 * the COGS report route and the P&L route feed their fetched rows through it so
 * the dollar math (and its sign handling) can't drift between the two.
 */

/** The cost-bearing columns of a stock/packaging adjustment row (decimal dollars). */
export interface CostAdjustmentRow {
  /** Recorded decimal-dollar change in inventory value (negative = consumed). */
  total_value_change: number | null;
  /** Decimal-dollar unit cost, used only when total_value_change is absent. */
  cost_per_unit: number | null;
  /** Units consumed. */
  quantity: number | null;
}

/**
 * Cost of a single adjustment, in dollars, as a positive magnitude.
 *
 * Prefers the recorded `total_value_change`; falls back to
 * `quantity × cost_per_unit` only when it is null/undefined. Never mixes units:
 * every input here is already dollars, so the result is dollars — no ×100 / ÷100
 * belongs at this seam.
 */
export function adjustmentCost(row: CostAdjustmentRow): number {
  return Math.abs(
    row.total_value_change ?? (row.quantity ?? 0) * (row.cost_per_unit ?? 0)
  );
}

/** Sum of `adjustmentCost` across rows, in dollars. Empty list → 0. */
export function sumAdjustmentCost(rows: readonly CostAdjustmentRow[]): number {
  return rows.reduce((sum, row) => sum + adjustmentCost(row), 0);
}
