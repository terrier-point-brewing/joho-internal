// Centralized data-category color classes for finance badges/pills.
//
// Most states map onto the semantic design tokens (success/info/accent/danger/neutral).
// Two finance-specific categories have NO semantic-token equivalent and stay as deliberate
// category hues — but they live ONLY here, and they bind to the theme-flipping
// `--cat-{hue}-*` tokens (dark defaults in app/globals.css, light values emitted by
// BrandChrome) rather than raw Tailwind hues, so they read on both themes:
//   • violet = QuickBooks source
//   • teal   = export invoice type
//
// See docs/UI_STANDARD.md §2 (off-palette data-category colors must be centralized).

/**
 * Invoice status pill (`bg + text`). `!`-prefixed so these values win over
 * <Badge>'s own default-tone bg/text when passed through its `className` —
 * Tailwind resolves same-property utility conflicts by generated stylesheet
 * order (not by className string order), so an un-prefixed override here is
 * not reliably guaranteed to beat Badge's own classes.
 */
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
  quickbooks: "bg-[var(--cat-violet-bg)] text-[var(--cat-violet-fg)]",
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
  export_invoice:     "bg-[var(--cat-teal-bg)] text-[var(--cat-teal-fg)]",
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

/**
 * QuickBooks sync-status pill, keyed by the normalized QbSyncState
 * (lib/finance/qbSyncStatus.ts). Tones mirror the finance conventions: synced =
 * success (like a "paid" pill), partial/ready = info (attention / staged),
 * not-synced = muted neutral. `unknown` renders no badge, but is mapped for
 * completeness.
 */
export const QB_SYNC_CLS: Record<string, string> = {
  synced:    "bg-success-surface/40 text-success",
  partial:   "bg-info-surface/40 text-info",
  ready:     "bg-surface-mid text-info",
  not_ready: "bg-surface-mid text-muted",
  unknown:   "bg-surface-mid text-faint",
};
