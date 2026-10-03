---
name: project_backfill_panels_settings
description: "All four data backfills now have a Settings UI (PR #292); the Tax one has no dry-run and can destroy tax rows"
metadata: 
  node_type: memory
  type: project
  originSessionId: 173f2361-1ae6-45e0-a9b8-aafb08bfe855
  modified: 2026-07-29T02:30:41.022Z
---

**PR #292 MERGED** 2026-07-28 (`50801e0`), no migration. Branch deleted.

Backfills were effectively unreachable: the tips GL one sat collapsed at the *bottom* of
Finance → Payroll with nothing in the nav pointing at it — which is why it sat un-run for
a day after its migrations landed — and the other three had no UI at all, only `curl`.

Now one **Backfill** subtab per domain, all sharing `app/settings/BackfillShell.tsx`:

| Backfill | Location | Route |
|---|---|---|
| Tips GL | Settings → Payroll → Backfill | `POST /api/payroll/gl-reports/backfill` |
| Sales tax | Settings → Finance → Backfill | `POST /api/finance/backfill/sales-tax` |
| Deposit breakdown | Settings → Production → Backfill | `POST /api/production/deposit-invoices/backfill` |
| Line item taxes | Settings → Tax → Backfill | `GET /api/tax/backfill-line-item-taxes` |

`app/finance/payroll/GlBackfillPanel.tsx` was deleted; its preview→review→run gate and
bucket-total invariant live on in the payroll settings page.

## ⚠️ The four routes are NOT uniform

- finance / payroll: `{ dryRun }`, defaults **true**
- production: **inverted** `{ apply }` — normalized in the page, route untouched
- tax: **NO dry-run at all.** A `GET` that writes on its only call. It also
  **delete-then-inserts per order from a live Square re-fetch**, so if Square returns an
  order without its taxes, the rows are deleted and not replaced. Since #286 the
  sales-tax liability AND the NC DOR / Wake taxable base are both derived from
  `pos_line_item_taxes`, so a bad run silently understates what we owe. The page shows no
  preview button and says why; date range is required.

## Durable gotchas

- **Two capability mismatches**, both of which would have rendered a tab that fails on
  click. The nav's per-entry `requires` is the fix:
  - production backfill enforces `production.export:manage`; its group gates
    `production.settings:manage` — a *different* scope, not a parent.
  - tax backfill enforces `finance.tax:manage`; its group gates the *child*
    `finance.tax.filing:manage`, so a filing-only holder would see it.
- **Banner/Badge have no `warning` tone** — only `neutral | accent | success | danger |
  info` (`app/components/ui/tone.ts`). Irreversible actions use `danger` (Banner's default).
- A confirm-step button must be gated on the same `disabled` as the trigger: inputs can be
  cleared *after* entering the confirm state, firing the write with empty parameters.

## Not verified

Never seen rendered — the app is behind a login wall and credentials are not enterable.
Compilation of all four routes and the nav wiring are confirmed by `npm run build`; the
visual result is not. Same gap as [[project_settings_nav_group_restructure]].

Related: [[project_sales_tax_in_revenue]], [[project_tips_balance_sheet_passthrough]].
