// Finance ledger types — stored invoices (QB import + future Square sync)
// Separate from the live Square API response types used in /api/finance/sales/*

export type InvoiceSource = "quickbooks" | "square" | "other";
export type InvoiceStatus = "open" | "paid" | "voided" | "partial" | "unknown" | "draft";
export type InvoiceType = "standard" | "allocation_deposit" | "export_invoice";

export type InvoiceLineCategory =
  | "ingredient_deposit"
  | "materials_packaging"
  | "packaging_fees"
  | "other_services"
  | "pass_through_taxes"
  | "distribution_keg"
  | "distribution_can"
  | "other";

export interface InvoiceLineItem {
  id: string;
  invoice_id: string;
  sort_order: number;
  description: string | null;
  category: InvoiceLineCategory | null;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  variation_name: string | null;
  raw_data: Record<string, string> | null;
  created_at: string;
}

export interface Invoice {
  id: string;
  source: InvoiceSource;
  external_id: string;
  square_invoice_id: string | null;
  invoice_number: string | null;
  invoice_date: string | null;        // ISO date string YYYY-MM-DD
  due_date: string | null;
  customer_name: string | null;
  partner_id: string | null;
  status: InvoiceStatus;
  invoice_type: InvoiceType;
  allocation_id: string | null;
  subtotal_cents: number;
  tax_cents: number;
  discount_cents: number | null;
  total_cents: number;
  notes: string | null;
  raw_data: Record<string, string> | null;
  created_at: string;
  updated_at: string;
  // Joined in list views
  invoice_line_items?: InvoiceLineItem[];
  contract_brewing_partners?: { company_name: string } | null;
}

export interface InvoiceBatchLink {
  id: string;
  invoice_id: string;
  batch_id: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  // Joined fields
  invoices?: Pick<Invoice, "id" | "invoice_number" | "invoice_date" | "customer_name" | "total_cents">;
  brew_batches?: { id: string; beer_name: string; batch_number: string | null; planned_brew_date: string };
}

// ── Import helpers ────────────────────────────────────────────────────────────

/** One parsed row from a QB CSV export (before grouping into invoices). */
export interface QBRow {
  invoice_number: string;
  invoice_date: string | null;
  due_date: string | null;
  customer_name: string;
  description: string;
  quantity: number;
  unit_price: number;   // dollars
  amount: number;       // dollars
  status: string;
  raw: Record<string, string>;
}

/** A fully assembled invoice ready to POST to /api/finance/ledger/invoices. */
export interface InvoiceImportPayload {
  source: InvoiceSource;
  external_id: string;
  invoice_number: string;
  invoice_date: string | null;
  due_date: string | null;
  customer_name: string;
  status: InvoiceStatus;
  total_cents: number;
  subtotal_cents: number;
  tax_cents: number;
  notes: string | null;
  raw_data: Record<string, string> | null;
  line_items: {
    sort_order: number;
    description: string;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
    raw_data: Record<string, string>;
  }[];
}
