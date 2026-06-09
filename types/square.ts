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
    pricing_type?: string;
    price_money?: Money;
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
  item_data: {
    name: string;
    product_type: string;
    variations: CatalogItemVariation[];
    reporting_category?: { id: string; ordinal: number };
    categories?: { id: string; ordinal: number }[];
    combo_type_details?: { slots: ComboSlot[] };
  };
}

export type CatalogObject = CatalogItem | CatalogItemVariation | { type: string; id: string };

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
  net_amount_due_money?: Money;
  line_items?: OrderLineItem[];
  discounts?: OrderDiscount[];
  total_money?: Money;
  total_tax_money?: Money;
  total_discount_money?: Money;
  total_tip_money?: Money;
}
