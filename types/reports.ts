import type { Order, OrderLineItem } from "./square";

// ---------------------------------------------------------------------------
// Cocktail Sales (combo + non-combo unified)
// ---------------------------------------------------------------------------

export interface CocktailSale {
  orderId: string;
  orderClosedAt: string;
  itemName: string;
  variationName: string;
  isCombo: boolean;
  quantity: number;
  grossSalesCents: number;
  discountsCents: number;
  netSalesCents: number;
  taxCents: number;
  rawOrder: Order;
  rawLineItems: OrderLineItem[]; // one entry for non-combo, N for combo components
}

// ---------------------------------------------------------------------------
// Combo Sales (internal — used as input to cocktail detection)
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

// ---------------------------------------------------------------------------
// Taproom Model
// ---------------------------------------------------------------------------

export interface TaproomCategoryTotals {
  grossSalesCents: number;
  discountsCents: number;
  returnsCents: number;   // refunds attributed to this category
  taxCents: number;
  netSalesCents: number;  // gross - discounts - returns
}

// One line's contribution to a category total.
//
// Emitted from the same two funnels that increment `byCategory` (see
// `addToCategory` / `addReturn` in lib/reports/taproom-model.ts), so the rows
// for a category sum *exactly* to that category's totals by construction —
// cocktail combos and keg detection included. Anything that reconstructs the
// same figures by re-reading orders would drift the moment the detection rules
// change; this cannot.
export interface TaproomLineContribution {
  categoryId: string;
  orderId: string;
  // "" when the contribution has no single source line — a prorated refund
  // fallback. Combo cocktails join their component uids with "+".
  lineUid: string;
  occurredAt: string;      // ISO; order created_at, matching sales-pulse day bucketing
  itemName: string;
  variationName: string;
  quantity: number;
  grossSalesCents: number;
  discountsCents: number;
  returnsCents: number;
  taxCents: number;
  discountNames: string[]; // names of discounts applied to the source line
  kind: "sale" | "return";
  // True when the amount was pro-rated across an order rather than read off a
  // returned line — no Square receipt shows this exact figure. Surface it, or
  // whoever drills in will go hunting for a line that doesn't exist.
  prorated: boolean;
}

export interface TaproomModelResult {
  byCategory: Record<string, TaproomCategoryTotals>;
  totalTipsCents: number;
  contributions: TaproomLineContribution[];
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
