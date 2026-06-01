// Raw Square API shapes — only fields we actually use

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
  source?: { name?: string };
  line_items?: OrderLineItem[];
  discounts?: OrderDiscount[];
  total_money?: Money;
  total_tax_money?: Money;
  total_discount_money?: Money;
  total_tip_money?: Money;
}
