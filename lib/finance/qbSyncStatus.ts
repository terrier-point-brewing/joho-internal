/**
 * Ramp → QuickBooks sync state, normalized for display and filtering.
 *
 * Ramp reports whether it has synced each object to the connected ERP
 * (QuickBooks, via its DIRECT native integration) through a raw `sync_status`
 * whose enum DIFFERS by object type:
 *   • card txns / bank lines: NOT_SYNC_READY | SYNC_READY | SYNCED
 *   • bills:                  NOT_SYNCED | BILL_SYNCED | BILL_AND_PAYMENT_SYNCED
 *
 * We store the raw value (see migration 20260805) and collapse it here to one
 * display state. `partial` (a bill whose bill is in QB but whose payment isn't)
 * is kept distinct because it's the granularity that matters for settlement
 * dedup and the future QB export route.
 */
export type QbSyncState = "synced" | "partial" | "ready" | "not_ready" | "unknown";
export type RampObject = "card" | "bill" | "bank";

export function normalizeQbSyncStatus(raw: string | null | undefined): QbSyncState {
  switch (raw) {
    case "SYNCED":
    case "BILL_AND_PAYMENT_SYNCED":
      return "synced";
    case "BILL_SYNCED":
      return "partial";
    case "SYNC_READY":
      return "ready";
    case "NOT_SYNC_READY":
    case "NOT_SYNCED":
      return "not_ready";
    default:
      return "unknown";
  }
}

/**
 * Human label for the badge. Mostly a function of the normalized state, with one
 * bill-specific wording: a `partial` (BILL_SYNCED) bill reads "Bill only" to make
 * clear the bill is in QuickBooks but its payment isn't yet.
 */
export function qbSyncLabel(raw: string | null | undefined, _rampObject: RampObject): string {
  switch (normalizeQbSyncStatus(raw)) {
    case "synced":
      return "Synced";
    case "partial":
      return "Bill only";
    case "ready":
      return "Ready";
    case "not_ready":
      return "Not synced";
    default:
      return "—";
  }
}
