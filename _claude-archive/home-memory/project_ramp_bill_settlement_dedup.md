---
name: ramp_bill_settlement_dedup
description: Ramp bills paid via direct ACH autopay (not Ramp Bill Pay) were double-counted as a second expense; fixed via bill-vs-bank amount+vendor matching
metadata: 
  node_type: memory
  type: project
  originSessionId: 5d2dfc62-3093-4350-9595-46b93726d28d
---

2026-07-18: found and fixed a real double-count in [[ramp_unified_ledger]] — a Ramp bill paid via a plain bank ACH autopay (not routed through Ramp's own Bill Pay "Vendor Payment" rail) surfaces in the bank feed as a generic "Withdrawal" and was booked as a brand-new operating expense on top of the bill's own line items. Caught via a real case: Duke Energy bill (12 line items, $4,833.55 total, accrued 2026-06-29) whose bank settlement on 2026-07-16 was *also* live in `expenses`.

**Root cause, non-obvious**: Ramp's bank-feed ACH descriptor mashes the vendor name together with no separators (`DUKEENERGY`), while the Bill object's `vendor_name` is human-readable (`Duke Energy`). The existing `normalizeCounterparty()` (lowercase + whitespace-collapse only) never equates these, so naive counterparty-key matching silently fails. Also: `RampBill.status` cannot be used as a "this bill was paid" signal — bills paid outside Ramp's own Bill Pay flow stay `OPEN` in Ramp forever, since Ramp never learns about payment on that rail.

**Fix (PR #228, merged)**: [lib/finance/bankLedger.ts](../lib/finance/bankLedger.ts) adds `billMatchKey()` (alnum-only, strips all punctuation/spaces) + `buildBillTotals()` (sums a bill's `:N` line items keyed by that fuzzy vendor key); `classifyBankLine()`'s Withdrawal branch now checks amount+vendor against recorded bill totals before defaulting to `operating_expense`. [lib/finance/rampSync.ts](../lib/finance/rampSync.ts) loads bill totals from a fixed 120-day lookback **independent of the caller's own sync window** — the daily cron uses 45 days, the webhook resync only 2 — so a narrow resync can never regress an already-excluded settlement back into a live double-counted expense (this cross-window race would otherwise have re-broken the fix within days of it working).

**How to apply**: if a future vendor/bill dedup issue looks similar (amount matches but records don't dedup), suspect a normalization mismatch between Ramp's bank-feed descriptor format and the human-readable name stored elsewhere — check with `billMatchKey`-style alnum stripping before assuming the data is simply wrong. The one historical duplicate row was corrected directly in prod by the user (moved from `expenses` into `ramp_bank_ledger` as excluded `bill_settlement`) — no migration needed, it was a data-only fix, not schema.
