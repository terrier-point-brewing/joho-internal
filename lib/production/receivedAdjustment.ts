export interface ReceivedAdjustmentInput {
  currentStock: number;
  currentCostPerUnit: number | null;
  quantity: number;
  purchaseCost: number;
  shippingCost: number;
}

export interface ReceivedAdjustmentResult {
  landedCostPerUnit: number;
  newStock: number;
  newCostPerUnit: number;
}

/**
 * Landed cost bakes shipping into the per-unit cost of a "received" adjustment;
 * new cost is the stock-weighted average of the existing on-hand value and the
 * newly landed value. Shared by the single-item and bulk received-adjustment
 * routes for both ingredients and packaging so the math has one source of truth.
 */
export function computeReceivedAdjustment(
  input: ReceivedAdjustmentInput
): ReceivedAdjustmentResult {
  const { currentStock, currentCostPerUnit, quantity, purchaseCost, shippingCost } = input;
  const landedCostPerUnit = (purchaseCost * quantity + shippingCost) / quantity;
  const newStock = currentStock + quantity;
  const newCostPerUnit =
    newStock > 0
      ? (currentStock * (currentCostPerUnit ?? 0) + quantity * landedCostPerUnit) / newStock
      : landedCostPerUnit;
  return { landedCostPerUnit, newStock, newCostPerUnit };
}
