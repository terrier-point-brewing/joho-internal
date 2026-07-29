# Sales Tax as a Balance-Sheet Liability — Design

**Date:** 2026-07-28
**Status:** Approved, ready for planning
**Builds on:** PRs #283 / #284, both merged; rebased onto `2892d18` — see [Inherited](#inherited-from-prs-283--284-both-merged)

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

`squareTaxBase.test.ts` acts as the **equivalence gate** for the change — this is
a shared pure function on a live filing path. Note the precise form the gate
takes here: its stub rows currently expose only `net_sales_cents`/`tax_cents`, so
a literal freeze cannot compile against a `gross − discount` implementation.

The gate is therefore: **every `expect(...)` value stays byte-identical**, and
the fixtures gain `gross_sales_cents`/`discount_cents` chosen to satisfy
`net = gross − discount + tax` (e.g. the existing `net 10000 / tax 725` row
becomes `gross 9275, discount 0`). If any expected value has to move to make the
suite pass, stop — that means the rebase is not equivalent and the premise is
wrong.

## Data model

Two migrations, taking **`20260825`** and **`20260826`**. `20260821`–`20260824`
are on disk and claimed (`20260821` payroll shift overrides, `20260822`
grant-aware RLS, `20260823`/`20260824` the merged tips branch).

Probed against prod on 2026-07-28: `payroll_shift_overrides`,
`payroll_gl_settings.tips_chart_of_accounts_id`, and
`payroll_gl_report_totals.bucket_kind` all **exist**, so `20260821`, `20260823`,
and `20260824` are already applied. `20260822` is policy-only and cannot be
probed through PostgREST — confirm it in `schema_migrations` before pushing.

The CLI keys on the digits before the first `_`; verify `schema_migrations`
before any push — this repo already carries duplicated prefixes from earlier work.

### `20260827_square_tax_accounts.sql`

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

### `20260828_invoice_line_item_taxes.sql`

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

New subtab **Sales Tax Accounts** at `app/settings/finance/sales-tax-accounts/`,
added to `FINANCE_SETTINGS_NAV` in `app/settings/nav-config.ts`.

(Originally specced against `app/finance/settings/` + `SettingsNav.tsx`'s
`SUBTABS`. PR #287 landed mid-flight, consolidating every settings screen into
`/settings/<group>/<subtab>` and deleting `SettingsNav.tsx`; this branch follows
the new structure. The API route did **not** move — #287 relocated pages only.)

Modelled directly on `app/settings/finance/counterparty-accounts/page.tsx`,
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

`fetchTaxAccruals(supabase, range, accountByTaxId)` in
`lib/finance/financials/fetchSources.ts`, modelled directly on the merged
`fetchTipAccruals`:

- Union `pos_line_item_taxes` and `invoice_line_item_taxes`, joined to their
  parent line's order/invoice date, ranged over the BS window
- Group by **`square_tax_id` only** — *not* by month. Balance-sheet mode
  collapses every record onto a single synthetic month key
  (`cumulativeRange`'s `canonicalMonth`), so `fetchTipAccruals` emits exactly
  one record and derives `monthKey` as `range.endDateStr.slice(0, 7)`. Do the
  same, one record per mapped account.
- Resolve each tax to an account via `square_tax_accounts`; sum per account, so
  two taxes pointing at the same account merge into one record
- Paginate via `fetchAllRows` — PostgREST silently truncates at 1000 rows, and
  `pos_line_item_taxes` already holds 8,814 rows
- **Balance-sheet mode only**, the same way `openInvoiceArCents` and
  `fetchTipAccruals` are, so the P&L and cash-flow payloads and their cost are
  untouched
- Chained inside the existing `Promise.all` as
  `fetchTaxAccountMap(supabase).then((map) => fetchTaxAccruals(supabase, range, map))`,
  exactly as the tips lookup is, so the settings read stays parallel rather than
  serializing in front of everything else
- A tax with a NULL account emits **nothing** — the Financials page must never
  break on missing config
- Per-account degenerate guard: skip any account whose summed tax is `<= 0`.
  The `-magnitude` branch signs a negative sum identically to a positive one, so
  a negative total would silently read as *more* liability. This mirrors
  `fetchTipAccruals`'s `if (amountCents <= 0) return []`.

A status filter is **not** required: `pos_line_item_taxes` cascades from
`pos_line_items`, whose rows are deleted for canceled orders, so canceled tax
cannot survive. (This is why `fetchTipAccruals` *does* need `.eq("status",
"COMPLETED")` — a canceled order keeps its header `tip_cents`.) Prod confirms
every tax-bearing order is `COMPLETED`. Add the filter anyway as cheap defence,
and say in the comment that it is defensive rather than load-bearing.

### Missing-table degradation (required, not optional)

PostgREST 400s on a query against a table that does not exist, so both new
readers must survive the merge→migration window:

- `fetchTaxAccountMap` catches its own error and returns an **empty map**, so
  `fetchTaxAccruals` emits nothing and the balance sheet renders exactly as it
  does today. This is the same shape as the merged `fetchTipsAccountId`, which
  wraps its settings read in `try { ... } catch { return null; }` for precisely
  this reason.
- `fetchTaxAccruals`'s `invoice_line_item_taxes` source is wrapped the same way
  and degrades to contributing zero, leaving the POS accrual intact.
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

### Blocker: `invoice_line_items.square_line_item_uid` is corrupt

Attaching tax to an invoice line needs a reliable line key, and the obvious one
is broken. **60 of the 64 populated `square_line_item_uid` values point at the
wrong Square line, across 18 invoices.** Each row carries the *previous* line's
uid.

Two writers disagree on indexing:

- `buildInvoiceLineItems` (`syncPosTransactions.ts:199`) inserts
  `sort_order: idx + 1` — **1-based** — together with `square_line_item_uid`.
- `buildInvoiceLineItemRows` (`invoiceLineItems.ts:83`) writes `sort_order`
  **0-based**, and skips Barrel Excise Tax carve-out lines entirely.
- `persistInvoiceLineItems` upserts with
  `{ onConflict: "invoice_id,sort_order" }`. `square_line_item_uid` is not a
  member of `CanonicalLineItemRow`, so the upsert leaves it untouched and the
  stale 1-based uid stays glued to the 0-based canonical row.

Verified on invoice `35acf8f5`: the row described `CO2 Refill — 20#` with
`tax_cents = 673` stores uid `992032da`, which in `raw_data` is the Forklift
Service Fee (`tax 0`). The correct uid is `f9d90286`.

Keying invoice tax on this column would attach every tax to the wrong line and
feed a wrong taxable base to the NC DOR worksheet.

**Fix:** add `square_line_item_uid: string | null` to `CanonicalLineItemRow` and
set it from `li.uid ?? null` inside `buildInvoiceLineItemRows`'s existing push,
so uid and `sort_order` are correct by construction and every subsequent invoice
sync self-heals. The backfill repairs the 60 historical rows in the same pass
that populates `invoice_line_item_taxes`.

This also removes the need to replay the excise-skip logic in the backfill: once
uid is authoritative, `raw_data.line_items[].uid → invoice_line_items.id` is a
direct join.

## Backfill

One route, `POST /api/finance/backfill/sales-tax`, **dry-run by default**
(`dryRun` defaults true, matching the tips backfill's contract). Logic in
`lib/finance/backfillSalesTax.ts`. Four steps, each separately reported. Steps 2
and 3 are ordered — step 3 depends on the key step 2 repairs; steps 1 and 4 are
independent:

1. **`pos_line_items.net_sales_cents`** → `gross_sales_cents − discount_cents`.
   Idempotent: rows already satisfying the identity are skipped, so a re-run is
   a no-op. Guard: abort the row if `net_sales_cents ≠ gross − discount + tax`,
   since the correction is only provably safe where the identity holds. Report
   any such row rather than guessing.
2. **`invoice_line_items.square_line_item_uid`** → repaired from
   `square_orders.raw_data` by replaying `buildInvoiceLineItemRows`'s own
   iteration (skip carve-out excise lines, increment `sort_order` per pushed
   row) and matching on `sort_order`. Each match is **verified** against the
   row's `gross_sales_cents`/`discount_cents`/`tax_cents` before writing; an
   invoice whose triples don't line up is reported and skipped, never guessed
   at. This is the one step that cannot key on uid, because uid is what it is
   repairing.
3. **`invoice_line_item_taxes`** ← rebuilt from `square_orders.raw_data`,
   joining `raw_data.line_items[].uid → invoice_line_items.square_line_item_uid`
   (now trustworthy after step 2). Delete-then-insert per invoice, so re-runs
   converge.
4. **`invoice_line_items.total_cents`** → `gross − discount` for any row where
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
5. **Refund contra-revenue stays tax-inclusive while revenue becomes tax-free.**
   Found in the final whole-branch review. `square_refunds.amount_cents` is
   gross of tax and posts as `-magnitude` against revenue, so a refund of a
   taxed sale now reverses more revenue than was ever recognized. Before this
   branch the two sides were symmetric (both tax-inclusive); after it they are
   not.

   Sized against prod on 2026-07-28: 8 COMPLETED refunds totalling $1,899.58,
   so the maximum exposure is **~$128.41** if every refunded dollar were fully
   taxable — about 0.3% of recognized revenue, against the $2,887.32 this branch
   corrects.

   Not fixable in code: `square_refunds` stores a single total with no tax
   breakdown, and `square_payments` is not persisted at all, so the tax
   component of a refund cannot be derived from persisted data. Closing it needs
   either a Square refund-tax sync or a manual adjustment. Recorded here rather
   than silently absorbed.
6. **`square_tax_accounts` is not registered in `coa_reference_count()`.**
   Deleting a mapped account through the Chart of Accounts UI passes the
   reference guard and silently nulls the mapping, after which that tax stops
   accruing. The `unmappedTaxes` data-quality tile surfaces it, but only after
   the fact. The guard lives in migration `20260802`, which belongs to another
   unmerged branch and is deliberately not edited here — follow-up work.
7. **The backfill issues one UPDATE per row.** ~4,740 for step 1 alone, at
   concurrency 50, against the route's `maxDuration = 300`. A timeout leaves it
   partially applied; every step is idempotent, so the remedy is simply to run
   it again. Expect that rather than assuming a single pass.

## Inherited from PRs #283 / #284 (both merged)

Both merged on 2026-07-28; this branch is rebased onto `2892d18`. The rebase was
clean — this branch carried only the spec document at that point. What they
provide, and what this work must therefore *not* re-invent:

**The balance-sheet sign fix is in.** `normalizeSign.ts` now flips the
cash-direction sign for `expense`/`bank` on any BS section (`return -rawCents`),
so a remittance correctly *reduces* the liability. It also added a
`statementSection === "bank"` carve-out that returns `rawCents` unflipped, so
`cashOnHandCents` reads as net movement. Do not touch either branch.

**`tip_accrual` already exists in both source unions** — `type NormalizeSource`
at `aggregateRows.ts:151` and the inline `source:` parameter at
`normalizeSign.ts:50`. Adding `"tax_accrual"` follows an established, working
path rather than blazing one. It falls through to the pos/invoice branch, where
`other_current_liabilities ∈ NEGATIVE_SECTIONS` yields `-magnitude` — collection
posts negative (we owe more), remittance positive (we owe less). Exactly the
behavior this design needs, with no further sign work.

**`fetchTipAccruals` is the template** for the collection leg: BS-only, chained
inside `Promise.all` so the settings lookup stays parallel, single record keyed
to `range.endDateStr.slice(0, 7)`, `<= 0` degenerate guard, and a settings
reader (`fetchTipsAccountId`) that swallows its own error. Mirror all five
properties; the differences are the per-tax account map and the two-table union.

`20260823`/`20260824` are applied in prod, so nothing from that branch is
pending.

## Testing

Co-located `*.test.ts` for every new or modified `lib/` module, per the repo
rule; `npm run verify` must pass.

- `squareTaxBase.test.ts` — **frozen first** as an equivalence gate, then
  extended for the invoice-source union
- `syncPosTransactions.test.ts` — **the shared `order` fixture must be corrected
  first.** It currently sets line `total_money: 1350` with `gross 1400`,
  `discount 50`, `tax 100` — i.e. `gross − discount`, tax-*exclusive*. Prod is
  the opposite: line `total_money` is tax-**inclusive** on both POS and invoice
  orders (verified: CO2 Refill `10000 − 724 + 673 = 9949`). Because the fixture
  is unrealistic, `net_sales_cents: 1350` passes under **both** the buggy and
  the fixed implementation — the existing tests cannot detect this bug at all.
  Set `total_money: 1450` so the fixture satisfies the prod identity; the
  existing assertions then fail against current code (proving the bug) and pass
  after the fix. Then extend for `buildInvoiceLineItems`' tax-free `total_cents`
  and the generalized `buildLineItemTaxRows` across both tables.
- `invoiceLineItems.test.ts` — `buildInvoiceLineItemRows` emits
  `square_line_item_uid` aligned with its own `sort_order`, including across a
  skipped carve-out excise line (the case that produces the off-by-one).
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

1. Back up `pos_line_items`, `invoice_line_items`, `chart_of_accounts`.
2. Verify `schema_migrations`. `20260821`/`20260823`/`20260824` are confirmed
   applied; `20260822` is policy-only and must be checked there directly. This
   branch should add exactly **two** migrations to the pending set.
3. Apply migrations. Confirm `square_tax_accounts` holds two rows with non-NULL
   `chart_of_accounts_id`; a NULL means the seed's name lookup missed and must
   be set through the UI.

   ⚠️ **The new Settings → Sales Tax Accounts tab is live in the nav from the
   moment this deploys and will 500 until `20260825` is applied.** Unlike the
   Financials reads, `listSalesTaxAccounts` deliberately does not degrade — a
   settings page that silently shows an empty map would be worse than one that
   fails loudly. Apply the migration in the same window as the deploy.
4. Deploy. Confirm the Sales Tax Accounts settings page lists both taxes.
5. Create `Sales & Excise Taxes Payable:Wake County Tax Administration Payable`
   (Other Current Liabilities) via the Chart of Accounts UI.
6. Repoint Prepared Food & Beverage Tax to it on the Sales Tax Accounts page.
7. Recode the 2026-06-17 −$118.83 Wake County Tax Administration expense to that
   account via the Transactions tab. Verify:
   `select count(*) from expenses e join chart_of_accounts c on c.id =
   e.chart_of_accounts_id where c.account_name like '%Wake County%'` returns 1.
8. `POST /api/finance/backfill/sales-tax` with no body (dry run). Confirm the
   three monthly deltas match the restatement table exactly and that no row is
   reported as failing the identity guard. Do not proceed on a partially
   successful dry run.
9. `POST` with `{"dryRun": false}`.
10. Verify on Financials: May–July revenue drops by $2,887.32 in total, and the
    two liability accounts carry Σcollected − Σremitted.
11. Re-run one NC DOR worksheet for a closed period and confirm the collected
    figure now includes invoice tax.

Verified against prod on 2026-07-28 (read-only): all 4,740 POS rows satisfy the
`net = gross − discount + tax` identity; `pos_line_item_taxes` reconciles to
`pos_line_items.tax_cents` with zero drift; exactly two `square_tax_id`s exist;
every tax-bearing order is `COMPLETED` and non-invoice; two invoices carry tax
totalling $201.26, all General Sales Tax; and `Barrel Excise Tax` invoice lines
carry an empty `applied_taxes` array.
