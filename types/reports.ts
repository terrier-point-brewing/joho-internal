import type { Order, OrderLineItem } from "./square";

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
