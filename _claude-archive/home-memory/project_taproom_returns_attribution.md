---
name: project_taproom_returns_attribution
description: "2026-07-21 Square returns were silently dropped to $0 across Performance/net-sales/P&L; refund.order_id is a return order, not the sale. PR #232, migration 20260807 APPLIED."
metadata: 
  node_type: memory
  type: project
  originSessionId: 437b413e-d096-4342-a283-c63a5dec3f31
  modified: 2026-07-22T00:45:01.439Z
---

2026-07-21: Taproom Performance "Returns" column read $0 for every refund. Root cause: a Square refund's `order_id` points at a SEPARATE **return order** Square creates — negative total, NO `line_items`, goods under `returns[].return_line_items`, original sale under `returns[].source_order_id`. `buildTaproomModelReport` assumed it was the sale, so `orderTotal` summed an empty array → zero-guard → every refund dropped.

**Blast radius:** net-sales-summary, Finance P&L taproom revenue, and Performance all call `buildTaproomModelReport` → all three overstated net sales by the full refund amount. Jul 13-19 = $385 dropped (Kegs $298, deposits/Other $80, Draft $7), all Jul 19.

**Fix (PR #232 MERGED, worktree cleaned — read-time, no migration needed for the report fix):**
- Read returns off `order.returns[].return_line_items`; attribute each line to its own category by `catalog_object_id`+`gross_return_money` (EXACT, not pro-rated), net of line discount, ex-tax. Skip tip-only refunds (`return_tips`, no goods). Old proportional path kept as fallback for refunds pointing straight at a sale. Added `OrderReturn`/`OrderReturnLineItem` types to `types/square.ts`.
- Guest count (sales-pulse): new `isReturnOrder` (`lib/square/returnOrders.ts`) excludes return orders from the count — they return from the COMPLETED-orders search too and were phantom guests. They MUST stay in the array passed to the report (it resolves refunds against them) — filter counts, not the array.
- Refund drill-through: `syncRefunds` resolves return order → sale via `resolveSourceOrderIds`, stores the SALE in `square_order_id`/`order_id`; return-order id preserved in `raw_data.order_id`. NOTE: those two columns were write-only (no reader) before this — financials drill-through uses `chart_of_accounts_id`+refund-row id, not order_id.

**Migration `20260807_backfill_refund_source_orders.sql` APPLIED to prod 2026-07-21.** Backfilled existing `square_refunds` rows (walk: square_order_id=return order → square_orders.raw_data.returns[0].source_order_id → sale uuid). Idempotent. Was needed because finance-sync cron only re-syncs a 3-day window, so old rows wouldn't self-heal.

**Durable Square facts:** (1) a refund creates a distinct return order (empty line_items, negative `net_amounts`, `total_money`=0, tips=0); `refund.order_id` = that return order. (2) return_line_items repeat catalog_object_id + gross_return_money, so returns categorize WITHOUT the source order (works even if the sale is outside the fetch window). (3) `refund.amount_money` is tax-INCLUSIVE; use `gross_return_money` for ex-tax. Related: [[project_financials_consolidation]] (is_transfer/draft-restock $0 SKU handling).

**Discounts finding (not a bug):** Draft discounts Jul 13-19 = $326 / 20.2% of gross is REAL — ~74% employee/comp (Employee Draft Discount, Friends and family, Manager special), stacking on top of day promos (e.g. "Employee Draft Discount + $2 OFF Wednesday" = one $74 line). `total_discount_money` per line is Square's own figure; bucketing is correct.
