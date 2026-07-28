# Sales Tax as a Balance-Sheet Liability — Design

**Date:** 2026-07-28
**Status:** Approved, ready for planning
**Depends on:** PR #283 (`claude/tips-balance-sheet-passthrough`) — see [Dependency](#dependency-on-pr-283)

## Problem

Sales tax collected from customers is recognized as P&L revenue. It is money
held on behalf of NC DOR and Wake County, not income. Every recognized dollar of
taproom revenue is overstated by 7.3%.

`pos_line_items.net_sales_cents` is written from Square's line-item
`total_money` (`lib/finance/syncPosTransactions.ts:132`), which is
gross − discount **+ tax**. `lib/finance/financials/fetchSources.ts` `fetchPos`
maps it straight to `netSalesCents` (~line 248), and
`lib/finance/financials/aggregateRows.ts:193` passes it to
`normalizeSignedCents(row.netSalesCents, section, "pos")` with no tax
subtraction.

The codebase already knows the column is tax-inclusive. `lib/tax/squareTaxBase.ts:64`
computes `baseCents += num(pli.net_sales_cents) - num(pli.tax_cents)` with the
comment "base = net_sales_cents - tax_cents (post-discount, pre-tax receipts)".
The tax-filing module compensates; the Financials P&L does not.

### Verified against prod (read-only, 2026-07-28)

All 4,740 `pos_line_items` rows satisfy `net_sales_cents = gross_sales_cents −
discount_cents + tax_cents` exactly — zero exceptions. `tax_cents` reconciles to
`pos_line_item_taxes` to the cent, with **zero** unallocated tax and **zero**
lines carrying tax but no child rows.

Exactly two Square taxes exist, mapping to two different authorities:

| `square_tax_id` | Name | Rate | Collected (all time) | Authority |
|---|---|---|---|---|
| `ADD7EKQD2KN72NOYVUWHU34J` | General Sales Tax | 7.25% | $2,645.28 | NC DOR |
| `ARI25PLSGLDVIBUQITKTRNSX` | Prepared Food & Beverage Tax | 1% | $242.04 | Wake County |

Overstatement by month (completed, non-invoice POS orders — every tax row in
prod is `COMPLETED` and non-invoice):

| Month | General Sales | Prepared Food & Bev | Total |
|---|---|---|---|
| 2026-05 | $631.90 | $58.42 | $690.32 |
| 2026-06 | $1,032.43 | $86.44 | $1,118.87 |
| 2026-07 | $980.95 | $97.18 | $1,078.13 |
| **Total** | **$2,645.28** | **$242.04** | **$2,887.32** |

Against $39,525.31 of recognized POS revenue, that is 7.3% of every recognized
dollar.

### The liability side is empty

Five `Other Current Liabilities` accounts already exist for this purpose
(`Sales & Excise Taxes Payable` and its `Sales Tax Payable`, `North Carolina
Department of Revenue Payable`, `Out Of Scope Agency Payable`, and
`Square Sales Tax Payable` children). Nothing credits any of them on collection.
Only two rows post to any of them, both remittances, and both to
*NC DOR Payable*:

| Date | Amount | Merchant | Account |
|---|---|---|---|
| 2026-06-17 | −$118.83 | Wake County Tax Administration | NC DOR Payable ← **miscoded** |
| 2026-06-18 | −$1,296.50 | NC DEPT REVENUE | NC DOR Payable |

Zero `expense_gl_splits` and zero `ramp_bank_ledger` rows touch these accounts.
So the liability only ever drifts negative while revenue carries the offset.

### Questions the finding raised, answered

**Do invoice line items have the same problem?** **No.** The canonical builder
`lib/finance/invoiceLineItems.ts:142-144` writes `net_sales_cents = gross −
discount` and `total_cents = net`, parking tax in a separate `tax_cents` column.
`fetchInvoiceLines` reads `total_cents`. Verified in prod: 5 invoice lines carry
non-zero `tax_cents` ($201.26 total) and every one has `total_cents =
net_sales_cents`. Invoice revenue is already tax-free.

*But* — see [Invoice tax](#invoice-collected-tax) — that $201.26 is collected
tax that is neither credited to a liability nor visible to the tax filings.

**Does the excise work double-count?** **No.** Only the two `square_tax_id`s
above exist. Prod inspection of `square_orders.raw_data` for the taxed invoices
confirms `Barrel Excise Tax` line items carry an **empty** `applied_taxes` array
— excise flows through invoice line items and the `Pass-Through Excise Tax`
income account, never through Square order tax. The two mechanisms do not
intersect.

**Does correcting revenue require restating history?** **Yes**, and that is the
chosen behavior — see [Restatement](#restatement).

### A latent third instance of the same bug

`lib/finance/syncPosTransactions.ts:181` `buildInvoiceLineItems` is live (called
at line 295 for invoice-backed orders) and writes `total_cents:
li.total_money?.amount` — tax-**inclusive** — directly contradicting the
canonical `lib/finance/invoiceLineItems.ts`. Prod rows currently hold the
correct tax-free values, so the canonical writer wrote last. A re-sync of an
invoice-backed order would silently flip invoice revenue to tax-inclusive. It is
the same bug, in the same file being edited, and is fixed here.

## Goal

Collected sales tax never touches the P&L. It is recognized as a liability on
collection, credited per authority, and reduced by remittances — with the
authority↔account mapping user-configurable rather than hardcoded.

## Decisions

| Decision | Choice |
|---|---|
| Correction seam | Fix the writer + backfill the column (not derived-on-read) |
| Filing-base safety | Rebase `squareTaxBase` onto `gross − discount` so backfill ordering is irrelevant |
| Liability routing | Per-`square_tax_id` → account map, self-seeding, user-editable |
| Wake County account | Not created here; seed PF&B to the existing `Out Of Scope Agency Payable`, user repoints via UI |
| Credit mechanism | Derived on read, balance-sheet mode only, no new ledger table |
| Invoice tax | In scope — new `invoice_line_item_taxes` mirror table |
| Wake remittance recode | In scope, as an operator step (target account does not exist yet) |
| Restatement | Full — all history recomputed |

## Architecture

```
Square Order
  ├─ line total_money ──▶ pos_line_items.net_sales_cents   (tax REMOVED at write)
  │                            └──▶ fetchPos ──▶ revenue        ← corrected
  ├─ line applied_taxes ─▶ pos_line_item_taxes ─────┐
  └─ line applied_taxes ─▶ invoice_line_item_taxes ─┤  (invoice-backed orders)
                                                     │
                          square_tax_accounts map ───┤
                                                     ▼
                                          fetchTaxAccruals
                                         (balance_sheet only)
                                                     │
                                                     ▼
                                    Other Current Liabilities
```

The revenue correction is a **write-side** fix plus a backfill. The liability
credit is **derived on read** — no journal-entry machinery is invented, matching
the tips pass-through precedent.

`lib/finance/financials/summaries.ts` sums only `revenue`/`cogs`/`expenses`/
`other_income`/`other_expense` for P&L KPIs, so a liability-section accrual is
excluded **structurally**, not by a filter that can be forgotten.

## The ordering hazard, and its removal

Making `net_sales_cents` tax-free breaks `lib/tax/squareTaxBase.ts`, which
subtracts `tax_cents` to compensate. Left alone it would under-report the filing
base by exactly the tax amount the moment the backfill lands — and the hazard
window is unbounded, because code deploys and data backfills are separate acts.

Rather than sequence them, rebase the computation onto columns the backfill
never touches:

```
base = gross_sales_cents − discount_cents          (was: net_sales_cents − tax_cents)
```

Because `net = gross − discount + tax` holds on **every** prod row, this is
arithmetically identical both before and after the backfill. Deploy ordering
becomes irrelevant and the filings cannot drift.

`squareTaxBase.test.ts` is **frozen as an equivalence gate** before the change —
this is a shared pure function on a live filing path. Expect zero conflicts;
investigate any that appear rather than editing the test.

## Data model

Two migrations. `20260821`–`20260824` are already claimed and unapplied
(`20260821` payroll shift overrides, `20260822` grant-aware RLS, `20260823`/
`20260824` the tips branch), so these take **`20260825`** and **`20260826`**.
The CLI keys on the digits before the first `_`; verify `schema_migrations`
before any push — this repo already carries duplicated prefixes from earlier work.

### `20260825_square_tax_accounts.sql`

```
square_tax_id         text  primary key
tax_name              text
tax_pct               numeric
chart_of_accounts_id  uuid  null references chart_of_accounts(id)
created_at            timestamptz not null default now()
updated_at            timestamptz not null default now()
```

RLS enabled, service-role-only, matching the `pos_line_item_taxes` policy shape.

Seeded with the two known ids:

- `ADD7EKQD2KN72NOYVUWHU34J` → `Sales & Excise Taxes Payable:North Carolina Department of Revenue Payable`
- `ARI25PLSGLDVIBUQITKTRNSX` → `Sales & Excise Taxes Payable:Out Of Scope Agency Payable`

Seeds resolve the account by `account_name` and must be written so a no-match
leaves `chart_of_accounts_id` NULL rather than failing the migration — a NULL
maps to "no accrual emitted", which is safe, whereas a failed migration is not.

`tax_name`/`tax_pct` are display-only, refreshed on seed; the map keys on
`square_tax_id`.

### `20260826_invoice_line_item_taxes.sql`

Structurally identical to `pos_line_item_taxes`, one table over:

```
id            uuid primary key default gen_random_uuid()
line_item_id  uuid not null references invoice_line_items(id) on delete cascade
square_tax_id text not null
tax_name      text
tax_pct       numeric
amount_cents  integer not null default 0
created_at    timestamptz not null default now()
```

Indexes on `line_item_id` and `square_tax_id`; same service-role-only RLS.

The mirror shape is deliberate: it lets `fetchTaxableBase` and
`fetchTaxAccruals` each become a two-source union over one row shape, rather
than growing a second code path. A single `square_tax_id` column on
`invoice_line_items` was rejected because it can represent only one tax per
line, and POS lines already routinely carry two.

## Write-side changes

| File | Change |
|---|---|
| `lib/finance/syncPosTransactions.ts` `buildPosLineItems` | `net_sales_cents: gross_sales_money − total_discount_money`. `tax_cents` unchanged. |
| `lib/finance/syncPosTransactions.ts` `buildInvoiceLineItems` | `total_cents` and `net_sales_cents` → `gross − discount` (the latent bug above) |
| `lib/finance/syncPosTransactions.ts` `buildLineItemTaxRows` | Generalized to emit rows for either table — see below |
| `lib/tax/squareTaxBase.ts` | Base from `gross_sales_cents − discount_cents`; union POS + invoice sources |

`buildLineItemTaxRows` currently resolves a line's `applied_taxes[].tax_uid`
against the order's `taxes[]` and keys rows by a db-id map. Its logic is already
table-agnostic — only the row type's name differs. Generalize it to take the
db-id map and return the shared row shape, then have the POS path and the
invoice path each insert into their own table. Invoice-backed orders already
have their `invoice_line_items` ids available at insert time in the same
delete-then-insert block, so no new fetch is required.

## Settings UI

New subtab **Sales Tax Accounts** at `app/finance/settings/sales-tax-accounts/`,
added to `app/finance/settings/SettingsNav.tsx`'s `SUBTABS`.

Modelled directly on `app/finance/settings/counterparty-accounts/page.tsx`,
reusing `AccountSelect`, `Banner`, `Badge`, and `SaveHint`. No new primitives,
no raw colors.

Rows **seed themselves** from observed taxes, exactly as counterparty rules do:
on GET, any `square_tax_id` present in `pos_line_item_taxes` or
`invoice_line_item_taxes` but absent from `square_tax_accounts` is inserted with
a NULL account and its last-seen `tax_name`/`tax_pct`. A third tax appearing in
Square therefore surfaces in the UI automatically instead of being silently
dropped from the liability.

New route `app/api/finance/settings/sales-tax-accounts/` — GET (list + seed),
PUT (set one row's account). Business logic lives in
`lib/finance/salesTaxAccounts.ts`, not the handler.

## Collection leg

`fetchTaxAccruals(supabase, range)` in `lib/finance/financials/fetchSources.ts`:

- Union `pos_line_item_taxes` and `invoice_line_item_taxes`, joined to their
  parent line's order/invoice date, ranged over the BS window
- Group by (month, `square_tax_id`), resolve to an account via
  `square_tax_accounts`
- Emit one record per account per month
- Paginate via `fetchAllRows` — PostgREST silently truncates at 1000 rows, and
  `pos_line_item_taxes` already holds 8,814 rows
- **Balance-sheet mode only**, the same way `openInvoiceArCents` is BS-only, so
  the P&L and cash-flow payloads and their cost are untouched
- A tax with a NULL account emits **nothing** — the Financials page must never
  break on missing config

### Missing-table degradation (required, not optional)

PostgREST 400s on a query against a table that does not exist, so both new
readers must survive the merge→migration window:

- `fetchTaxAccruals` catches its own error and returns `[]`. The balance sheet
  then renders exactly as it does today. This mirrors the tips branch's
  deliberately-swallowed `fetchTipsAccountId` error.
- `fetchTaxableBase`'s **invoice** source is likewise wrapped and degrades to
  contributing zero, leaving the POS base — today's behavior — intact. Its POS
  source is not wrapped: that table exists and a silent zero there would corrupt
  a filing.

Without these guards, merging before applying migrations takes down the
Financials balance sheet and every tax worksheet. With them, the only surfaces
that hard-require the new tables are the settings page and the backfill route,
neither of which is on a critical path.

A new `"tax_accrual"` source takes the pos/invoice branch of
`normalizeSignedCents`, so sign derives entirely from the section:
`other_current_liabilities` is a negative section, so collection posts negative
(we owe more) and a remittance posts positive (we owe less). BS mode is
cumulative from inception, so the line reads Σcollected − Σremitted.

The source union is declared in **two** places and both must gain the member:
`type NormalizeSource` at `lib/finance/financials/aggregateRows.ts:132`, and the
inline `source:` parameter type in `normalizeSignedCents`
(`lib/finance/financials/normalizeSign.ts:50`). Changing only one compiles on
the call site but not the other.

### Data quality

`DataQualitySummary` (`lib/finance/financials/types.ts:35`) gains
`unmappedTaxes: { count: number; cents: number; href: string }`, passed into
`buildDataQuality` via `opts` the same way `exciseCoverage` is — it is a
config-coverage fact, not a property of the aggregated rows. `href` points at
the new settings subtab.

## Invoice-collected tax

The 5 taxed invoice lines total $201.26, all at 7.25% (General Sales Tax). They
are already excluded from revenue, so there is **no P&L overstatement** on the
invoice side. Two real defects remain:

1. The $201.26 is never credited to a liability.
2. `fetchTaxableBase` reads only `pos_line_item_taxes`, so the **NC DOR
   worksheets have been understating collected sales tax by $201.26.** This is a
   filing-accuracy bug, not a presentation bug.

Both are fixed by populating `invoice_line_item_taxes` and unioning it into
`fetchTaxableBase` and `fetchTaxAccruals`.

Historical rows are backfilled from `square_orders.raw_data`, which is persisted
in full and verified to carry the complete per-tax breakdown — for the
2026-06-12 invoice, `raw_data.taxes[0].catalog_object_id =
ADD7EKQD2KN72NOYVUWHU34J` with per-line `applied_taxes` of 7268/7267/4649 cents,
summing to the $191.84 header total.

## Backfill

One route, `POST /api/finance/backfill/sales-tax`, **dry-run by default**
(`dryRun` defaults true, matching the tips backfill's contract). Logic in
`lib/finance/backfillSalesTax.ts`. Three independent steps, each separately
reported:

1. **`pos_line_items.net_sales_cents`** → `gross_sales_cents − discount_cents`.
   Idempotent: rows already satisfying the identity are skipped, so a re-run is
   a no-op. Guard: abort the row if `net_sales_cents ≠ gross − discount + tax`,
   since the correction is only provably safe where the identity holds. Report
   any such row rather than guessing.
2. **`invoice_line_item_taxes`** ← rebuilt from `square_orders.raw_data` for
   invoice-backed orders, keyed to `invoice_line_items` by
   `square_line_item_uid` where present and by `sort_order` otherwise.
   Delete-then-insert per invoice, so re-runs converge.
3. **`invoice_line_items.total_cents`** → `gross − discount` for any row where
   they disagree *and* `net_sales_cents` is non-null, repairing anything the
   latent tax-inclusive writer produced. Rows with NULL `net_sales_cents` are
   hand-added lines (Packaging Fee, Ingredient Deposit — 22 in prod) and are
   left alone.

Dry-run output reports per-month before/after revenue deltas, asserted against
the table in [Restatement](#restatement).

Applied to prod by the orchestrator after explicit approval and a backup —
**never** by an implementation agent.

## Restatement

The backfill restates history. This is intended: the prior numbers were wrong,
and leaving May–July overstated while August onward is correct would make
month-over-month comparisons meaningless.

Expected revenue reduction, to the cent:

| Month | Reduction |
|---|---|
| 2026-05 | $690.32 |
| 2026-06 | $1,118.87 |
| 2026-07 | $1,078.13 |
| **Total** | **$2,887.32** |

Gross margin and $/BBL both move, since taproom revenue is the denominator.

### The two revenue paths converge

The legacy `/api/finance/pl` route builds revenue via
`lib/reports/taproom-model.ts`, where `netSalesCents = grossSalesCents −
discountsCents − returnsCents` — tax-free and already correct. The consolidated
Financials page includes tax. Same data, two different revenue numbers.

**`taproom-model.ts` is canonical**, and this work makes Financials agree with
it rather than the reverse. No change to `taproom-model.ts` is needed or made.
The residual difference after this change is the returns term, which is a
separate concern.

## Wake County remittance recode

The 2026-06-17 −$118.83 Wake County Tax Administration expense sits on *NC DOR
Payable*. Per-authority balances are wrong on day one until it moves.

This is specified as an **operator step, not code**: the target account does not
exist yet, because the decision was that Wake County gets a CoA row created
through the existing Chart of Accounts UI rather than seeded by a migration. A
migration cannot reference an account that does not exist, and hardcoding a
lookup that silently no-ops is worse than an explicit checklist item.

Documented in the deployment sequence below with a verification query.

## Known limitations

1. **The liability opens with a debit balance.** June's remittances ($1,296.50
   NC DOR, $118.83 Wake) exceed May-only collections ($631.90 / $58.42), so they
   evidently cover periods predating the POS data. The opening balance reflects
   that history gap, not a computation error. It should be cleared with an
   opening-balance entry once the pre-May filed amounts are known.
2. **Refunded tax is not netted.** `square_refunds` stores a single
   `amount_cents` with no tax breakdown, so refunded tax cannot be separated
   from refunded sales in persisted data. Collected tax is therefore gross of
   refunds — the same limitation the tips design documents, from the same
   missing data.
3. **Timing.** Tax collected near a period end is remitted in the next one, so
   the balance is expected to sit credit-side between filings.
4. **PF&B lands on `Out Of Scope Agency Payable` until repointed.** Deliberate,
   per the account decision; the name misdescribes the money in the interim.

## Dependency on PR #283

`normalizeSign.ts` currently returns `−magnitude` for `expense`/`bank` on a
balance-sheet section, which makes a liability **grow** when it is paid down.
The two existing remittance rows are already wrong because of it, and the tax
accrual's remittance leg depends on the fix.

PR #283 fixes this (`return -rawCents` for `expense`/`bank` on any BS section).
**This branch does not duplicate or revert that fix.** It rebases onto #283 once
merged. Both branches touch `normalizeSign.ts`, `fetchSources.ts`, and
`aggregateRows.ts`; conflicts are expected and resolved in favor of #283's
version of the shared sign logic.

If #283 is abandoned rather than merged, the sign fix must be lifted into this
branch verbatim, and its frozen `normalizeSign.test.ts` equivalence gate lifted
with it.

## Testing

Co-located `*.test.ts` for every new or modified `lib/` module, per the repo
rule; `npm run verify` must pass.

- `squareTaxBase.test.ts` — **frozen first** as an equivalence gate, then
  extended for the invoice-source union
- `syncPosTransactions.test.ts` — `buildPosLineItems` emits tax-free
  `net_sales_cents`; `buildInvoiceLineItems` emits tax-free `total_cents`;
  generalized `buildLineItemTaxRows` covers both tables. The existing
  `buildInvoiceLineItems` test at line 202 pins the current tax-inclusive
  behavior and **is expected to conflict** — that is the one legitimate
  conflict, since it pins the bug being fixed.
- `salesTaxAccounts.test.ts` — seeding is idempotent; unmapped tax yields no
  accrual
- `fetchSources.test.ts` — `fetchTaxAccruals` groups by tax and month, is empty
  outside balance-sheet mode, pages past 1000 rows, skips unmapped taxes, and
  returns `[]` (rather than throwing) when the underlying table errors
- `backfillSalesTax.test.ts` — dry run writes nothing; the identity guard
  rejects a row where `net ≠ gross − discount + tax`; re-runs are no-ops;
  monthly deltas reproduce the restatement table
- `normalizeSign.test.ts` — one added case for `"tax_accrual"` on
  `other_current_liabilities`

## Deployment sequence

Merging this branch **breaks nothing before migrations are applied**, but only
because of the guards specified in
[Missing-table degradation](#missing-table-degradation-required-not-optional).
Those guards are load-bearing for this property — verify them in review before
merging, not after.

1. Merge PR #283 first, then rebase this branch onto it.
2. Back up `pos_line_items`, `invoice_line_items`, `chart_of_accounts`.
3. Verify `schema_migrations` — `20260821`–`20260824` are also unapplied, so a
   push applies **six** migrations, not two.
4. Apply migrations. Confirm `square_tax_accounts` holds two rows with non-NULL
   `chart_of_accounts_id`; a NULL means the seed's name lookup missed and must
   be set through the UI.
5. Deploy. Confirm the Sales Tax Accounts settings page lists both taxes.
6. Create `Sales & Excise Taxes Payable:Wake County Tax Administration Payable`
   (Other Current Liabilities) via the Chart of Accounts UI.
7. Repoint Prepared Food & Beverage Tax to it on the Sales Tax Accounts page.
8. Recode the 2026-06-17 −$118.83 Wake County Tax Administration expense to that
   account via the Transactions tab. Verify:
   `select count(*) from expenses e join chart_of_accounts c on c.id =
   e.chart_of_accounts_id where c.account_name like '%Wake County%'` returns 1.
9. `POST /api/finance/backfill/sales-tax` with no body (dry run). Confirm the
   three monthly deltas match the restatement table exactly and that no row is
   reported as failing the identity guard. Do not proceed on a partially
   successful dry run.
10. `POST` with `{"dryRun": false}`.
11. Verify on Financials: May–July revenue drops by $2,887.32 in total, and the
    two liability accounts carry Σcollected − Σremitted.
12. Re-run one NC DOR worksheet for a closed period and confirm the collected
    figure now includes invoice tax.

Verified against prod on 2026-07-28 (read-only): all 4,740 POS rows satisfy the
`net = gross − discount + tax` identity; `pos_line_item_taxes` reconciles to
`pos_line_items.tax_cents` with zero drift; exactly two `square_tax_id`s exist;
every tax-bearing order is `COMPLETED` and non-invoice; two invoices carry tax
totalling $201.26, all General Sales Tax; and `Barrel Excise Tax` invoice lines
carry an empty `applied_taxes` array.
