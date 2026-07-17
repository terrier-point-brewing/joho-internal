// Centralized data-category color classes for finance badges/pills.
//
// Most states map onto the semantic design tokens (success/info/accent/danger/neutral).
// Two finance-specific categories have NO token equivalent and stay as deliberate category
// palettes — but they live ONLY here, never re-inlined per file:
//   • violet = QuickBooks source / deposit (BS→P&L) recognition
//   • teal   = export invoice type
//
// See docs/UI_STANDARD.md §2 (off-palette data-category colors must be centralized).

/** Invoice status pill (`bg + text`). */
export const INVOICE_STATUS_CLS: Record<string, string> = {
  paid:    "bg-success-surface/40 text-success",
  open:    "bg-accent-muted/40 text-accent",
  partial: "bg-info-surface/40 text-info",
  voided:  "bg-danger-surface/20 text-danger",
  draft:   "bg-surface-mid text-muted",
  unknown: "bg-surface-mid text-muted",
};

/** Invoice source labels + pill classes. */
export const INVOICE_SOURCE_LABEL: Record<string, string> = {
  square: "Square",
  quickbooks: "QuickBooks",
  other: "Other",
};
export const INVOICE_SOURCE_CLS: Record<string, string> = {
  square:     "bg-info-surface/40 text-info",
  quickbooks: "bg-violet-900/40 text-violet-400",
  other:      "bg-surface-mid text-secondary",
};

/** Invoice type labels + pill classes. */
export const INVOICE_TYPE_LABEL: Record<string, string> = {
  standard: "Standard",
  allocation_deposit: "Deposit",
  export_invoice: "Export",
};
export const INVOICE_TYPE_CLS: Record<string, string> = {
  standard:           "bg-surface-mid text-secondary",
  allocation_deposit: "bg-accent-muted/40 text-accent",
  export_invoice:     "bg-teal-900/40 text-teal-400",
};

/** POS order status pill (keyed by lower-cased status). */
export const ORDER_STATUS_CLS: Record<string, string> = {
  completed: "bg-success-surface/40 text-success",
  open:      "bg-accent-muted/40 text-accent",
  canceled:  "bg-danger-surface/20 text-danger",
  cancelled: "bg-danger-surface/20 text-danger",
  draft:     "bg-surface-mid text-muted",
};

/**
 * Ramp expense state pill (keyed by lower-cased state). Spans all three ramp_object
 * types: card txns (cleared/pending/declined/flagged), bills (paid/open), and bank
 * lines (cleared — a posted bank debit is settled). `paid`/`open` mirror the
 * INVOICE_STATUS_CLS tones so a "paid" pill reads the same everywhere in finance.
 */
export const EXPENSE_STATE_CLS: Record<string, string> = {
  cleared:  "bg-success-surface/40 text-success",
  paid:     "bg-success-surface/40 text-success",
  pending:  "bg-accent-muted/40 text-accent",
  open:     "bg-accent-muted/40 text-accent",
  declined: "bg-danger-surface/20 text-danger",
  flagged:  "bg-info-surface/40 text-info",
};

/** "Split by source" data category (info). */
export const SPLIT_CATEGORY_CLS = "text-info bg-info-surface/30";
/** "Deposit / QuickBooks" data category (violet — no token equivalent). */
export const DEPOSIT_CATEGORY_CLS = "text-violet-400 bg-violet-900/30";

// Deposit (BS→P&L) recognition surfaces. Violet is the deliberate no-token data
// category — these live here so no finance file re-inlines a raw violet class.
/** Deposit-recognition toggle button, active state. */
export const DEPOSIT_BS_TOGGLE_CLS = "bg-violet-900/40 border-violet-700 text-violet-300 hover:bg-violet-900/60";
/** Deposit-recognition expandable panel surface (bg + border color). */
export const DEPOSIT_SURFACE_CLS = "bg-violet-950/10 border-violet-900/20";
/** Deposit-recognition inline emphasized text. */
export const DEPOSIT_TEXT_CLS = "text-violet-300";
/** Deposit BS pill, active (unpaid → recognized on the balance sheet). */
export const DEPOSIT_BS_PILL_CLS = "bg-violet-900/60 text-violet-300";
