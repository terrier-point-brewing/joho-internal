import type { Order, OrderLineItem } from "./square";

// ---------------------------------------------------------------------------
// Combo Sales
// ---------------------------------------------------------------------------

// A single detected combo cocktail sale.
// Carries full context so downstream reports can extract any field they need.
export interface ComboSale {
  // Order context
  orderId: string;
  orderClosedAt: string; // ISO string

  // Combo identity
  comboName: string;
  comboCategoryId: string;
  comboCatalogItemId: string;
  comboVariationId: string;
  comboPriceCents: number; // fixed catalog price of the combo

  // Component line item (the actual line item in the order)
  componentVariationId: string;
  componentName: string;          // parent item name
  componentVariationName: string; // variation name
  componentStandalonePriceCents: number; // catalog price sold standalone
  pricedAtCents: number;          // what was actually charged per unit

  // Quantities and money (all in cents)
  quantity: number;
  comboNumSlots: number;          // number of required slots in this combo (used for qty aggregation)
  grossSalesCents: number;        // pricedAt * quantity
  discountsCents: number;
  netSalesCents: number;          // gross - discounts
  taxCents: number;

  // Raw objects for future reports to drill into
  rawOrder: Order;
  rawLineItem: OrderLineItem;
}

// ---------------------------------------------------------------------------
// Keg Sales
// ---------------------------------------------------------------------------

export const KEG_TRANSFER_DISCOUNT_NAME = "Keg Transfer (Set 660oz to Draft)";

// A single keg line item from an order.
// isTransfer=true means it was an internal draft inventory transfer, not a sale.
export interface KegSale {
  // Order context
  orderId: string;
  orderClosedAt: string; // ISO string

  // Keg identity
  beerName: string;   // item name with " (Keg)" stripped, e.g. "Carolina Pale Ale"
  kegSize: string;    // variation name, e.g. "1/6 Keg"
  catalogItemId: string;
  variationId: string;

  // Classification
  isTransfer: boolean;      // true if "Keg Transfer (Set 660oz to Draft)" discount applied
  discountNames: string[];  // all discount names applied to this line item

  // Quantities and money (all in cents)
  quantity: number;
  grossSalesCents: number;
  discountsCents: number;
  netSalesCents: number;
  taxCents: number;

  // Raw objects for future reports to drill into
  rawOrder: Order;
  rawLineItem: OrderLineItem;
}
