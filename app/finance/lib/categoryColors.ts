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

/** Ramp expense state pill (keyed by lower-cased state). */
export const EXPENSE_STATE_CLS: Record<string, string> = {
  cleared:  "bg-success-surface/40 text-success",
  pending:  "bg-accent-muted/40 text-accent",
  declined: "bg-danger-surface/20 text-danger",
  flagged:  "bg-info-surface/40 text-info",
};

/** "Split by source" data category (info). */
export const SPLIT_CATEGORY_CLS = "text-info bg-info-surface/30";
/** "Deposit / QuickBooks" data category (violet — no token equivalent). */
export const DEPOSIT_CATEGORY_CLS = "text-violet-400 bg-violet-900/30";
