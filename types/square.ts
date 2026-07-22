// Raw Square API shapes — only fields we actually use

// ── Square Invoices API ───────────────────────────────────────────────────────

export interface SquareInvoiceRecipient {
  customer_id?: string;
  given_name?: string;
  family_name?: string;
  company_name?: string;
  email_address?: string;
}

export interface SquareInvoicePaymentRequest {
  uid: string;
  request_type: string;
  due_date?: string;
  computed_amount_money?: Money;
  total_completed_amount_money?: Money;
}

export interface SquareInvoice {
  id: string;
  version: number;
  location_id: string;
  order_id: string;
  invoice_number?: string;
  title?: string;
  primary_recipient?: SquareInvoiceRecipient;
  payment_requests?: SquareInvoicePaymentRequest[];
  status: string;   // DRAFT | UNPAID | SCHEDULED | PARTIALLY_PAID | PAID | REFUNDED | CANCELED | FAILED
  created_at: string;
  updated_at?: string;
  scheduled_at?: string;
}

export interface Money {
  amount: number;
  currency: string;
}

export interface CatalogItemVariation {
  type: "ITEM_VARIATION";
  id: string;
  item_variation_data: {
    item_id: string;
    name: string;
    sku?: string;
    upc?: string;
    pricing_type?: string;       // FIXED_PRICING | VARIABLE_PRICING
    price_money?: Money;
    track_inventory?: boolean;
    sellable?: boolean;
    stockable?: boolean;
    service_duration?: number;   // ms, for service items
  };
}

export interface CatalogTax {
  type: "TAX";
  id: string;
  tax_data: {
    name: string;
    percentage?: string;
    inclusion_type?: string;     // ADDITIVE | INCLUSIVE
    enabled?: boolean;
  };
}

export interface CatalogDiscount {
  type: "DISCOUNT";
  id: string;
  discount_data: {
    name: string;
    discount_type?: string;      // FIXED_PERCENTAGE | FIXED_AMOUNT | VARIABLE_PERCENTAGE | VARIABLE_AMOUNT
    percentage?: string;
    amount_money?: Money;
  };
}

export interface ComboSlot {
  uid: string;
  name: string;
  num_selections: number;
  default_item_variation_id?: string;
  item_variation_ids: string[];
  price_adjustments?: { item_variation_id: string; amount: number; uid: string }[];
}

export interface CatalogItem {
  type: "ITEM";
  id: string;
  is_deleted?: boolean;
  item_data: {
    name: string;
    description?: string;
    product_type: string;
    variations: CatalogItemVariation[];
    reporting_category?: { id: string; ordinal: number };
    categories?: { id: string; ordinal: number }[];
    tax_ids?: string[];
    is_archived?: boolean;
    combo_type_details?: { slots: ComboSlot[] };
  };
}

export interface CatalogCategory {
  type: "CATEGORY";
  id: string;
  category_data: {
    name: string;
    is_top_level?: boolean;
    parent_category?: { id?: string; ordinal?: number };
    root_category?: string;
    category_type?: string;  // REGULAR_CATEGORY | MENU_CATEGORY
  };
}

export type CatalogObject = CatalogItem | CatalogItemVariation | CatalogCategory | CatalogTax | CatalogDiscount | { type: string; id: string };

export interface AppliedDiscount {
  uid: string;
  discount_uid: string;
  applied_money?: Money;
}

export interface OrderDiscount {
  uid: string;
  catalog_object_id?: string;
  name: string;
  percentage?: string;
  amount_money?: Money;
  applied_money?: Money;
  type?: string;
  scope?: string;
}

export interface OrderAppliedTax {
  uid: string;
  tax_uid: string;
  applied_money?: Money;
}

export interface OrderTax {
  uid: string;
  catalog_object_id?: string;
  name?: string;
  percentage?: string;
  type?: string;
}

export interface OrderLineItem {
  uid: string;
  catalog_object_id?: string;
  catalog_version?: number;
  quantity: string;
  name: string;
  variation_name?: string;
  note?: string;
  base_price_money?: Money;
  gross_sales_money?: Money;
  total_discount_money?: Money;
  total_tax_money?: Money;
  total_money?: Money;
  item_type?: string;
  applied_discounts?: AppliedDiscount[];
  applied_taxes?: OrderAppliedTax[];
}

// A single returned line on a return order. Square repeats enough of the
// original line here (`catalog_object_id`, `name`, money) that a return can be
// categorized without fetching the source order — which may fall outside the
// requested date range.
export interface OrderReturnLineItem {
  uid: string;
  source_line_item_uid?: string;
  catalog_object_id?: string;
  quantity: string;
  name: string;
  variation_name?: string;
  item_type?: string;
  // Ex-tax, ex-discount value of what came back.
  gross_return_money?: Money;
  total_discount_money?: Money;
  total_tax_money?: Money;
  total_money?: Money;
}

export interface OrderReturn {
  uid: string;
  // The original sale this return reverses.
  source_order_id?: string;
  return_line_items?: OrderReturnLineItem[];
  return_amounts?: {
    total_money?: Money;
    tax_money?: Money;
    discount_money?: Money;
    tip_money?: Money;
  };
}

export interface Order {
  id: string;
  location_id: string;
  state: string;
  created_at: string;
  updated_at?: string;
  closed_at?: string;
  customer_id?: string;
  source?: { name?: string };
  // App-stamped metadata. Orders created by our invoice flow (Orders API, then
  // an attached Square invoice) carry `{ source: "tpb-brewing", type: <invoice
  // kind> }`; native Square POS orders have none. See `isInvoiceOrder`.
  metadata?: Record<string, string>;
  net_amount_due_money?: Money;
  line_items?: OrderLineItem[];
  // Present only on return orders — the negative-total order Square creates for
  // a refund. Such orders carry NO `line_items`; the goods are in here.
  returns?: OrderReturn[];
  discounts?: OrderDiscount[];
  taxes?: OrderTax[];
  total_money?: Money;
  total_tax_money?: Money;
  total_discount_money?: Money;
  total_tip_money?: Money;
}
