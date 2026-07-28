# Tips as a Balance-Sheet Pass-Through — Design

**Date:** 2026-07-27
**Status:** Approved, ready for planning

## Problem

Tips are excluded from P&L revenue but included in P&L expense. The result is a
one-sided expense that understates operating income by roughly the paycheck-tip
amount every pay period (~$900–$1,050 biweekly, ~$2k/month at current volume),
and part of it inflates COGS specifically, so gross margin and $/BBL are also off.

### Revenue side — correctly excluded

- Financials sources taproom revenue from `pos_line_items.net_sales_cents`
  (`lib/finance/financials/fetchSources.ts` `fetchPos`). Tips are order-level
  (`total_tip_money`), never a line item, so they cannot enter.
- The legacy `/api/finance/pl` route sums only `byCategory[].netSalesCents`.
  `buildTaproomModelReport` tracks `totalTipsCents` as a separate unused figure
  (`lib/reports/taproom-model.ts`) and explicitly drops tip-only refunds.
- `square_orders.tip_cents` is persisted but read by no financials source.

### Expense side — incorrectly included

`lib/payroll/gustoParser.ts` deliberately excludes Cash/Paycheck Tips from the
GL bucket totals ("pass-through, not wage expense"). But
`computeProportionalSplits` in `lib/finance/payrollMatching.ts` scales the
period's GL *mix* to each matched expense's **full amount**, forcing lines to
sum to the bank debit "for ANY reconciliation variance between the matched total
and the period total." The Gusto ACH includes paycheck tips, so that excess is
spread pro-rata onto the wage accounts.

Verified against prod for pay period 2026-06-01 → 2026-06-14:

| | |
|---|---|
| Gross wages (Gusto report) | $5,557.61 |
| Employer taxes | $652.10 |
| **GL totals** | **$6,209.71** |
| Paycheck tips | $911.58 |
| Unexplained residual | $822.43 |
| **Matched GUSTO debits** | **$7,943.72** |

The resulting `payroll_auto` splits sum to the full $7,943.72, landing across
*Direct Production Labor* (COGS), *Taproom Staff Wages*, and *Payroll Taxes &
Processing Fees*. The same pattern holds for every period back to May.

The three employees showing $0 gross in that report genuinely worked 0 hours
(confirmed against `payroll_entries`), so the parser is **not** undercounting —
the residual is real variance, not a parsing gap.

### Cash in is invisible

Every positive bank row in June — $46,501.67 of Square deposits in
`ramp_bank_ledger` — is unmapped (`chart_of_accounts_id = null`), resolving to a
null section that contributes to no P&L section. That is correct on its own
(a deposit is cash movement, not revenue), but it means the tip dollars enter
the books exactly once, on the expense side only.

A `Payroll Liabilities:Undistributed Tips` account already exists
(`Other Current Liabilities`) with **zero** rows referencing it across
`expenses`, `expense_gl_splits`, `ramp_bank_ledger`, and
`payroll_gl_report_totals`. It was created and never wired up.

## Goal

Tips never touch the P&L on either side. Both legs post to one liability
account, and the attribution is explicitly recorded and configurable rather than
implicit in split arithmetic.

## Decisions

| Decision | Choice |
|---|---|
| Scope | Both legs — payout and collection |
| Payout tip source | Gusto CSV Paycheck Tips rows (authoritative, same document as wage buckets) |
| Residual handling | Unchanged — force-fill onto wage/tax, exactly as today |
| Cash tips | Excluded — no company money moves; they stay off both statements |
| Collection basis | Gross order tips (`square_orders.tip_cents`) |
| Credit mechanism | Derived on read, no new table |
| Backfill | Recompute all history |

## Architecture

Two independent read paths, one account:

```
Gusto CSV ──▶ gustoParser (tips bucket) ──▶ payroll_gl_report_totals
                                                    │
                                      computeProportionalSplits (exact carve-out)
                                                    │
                                            expense_gl_splits ──┐
                                                                ├──▶ aggregateRows ──▶ liability balance
square_orders.tip_cents ──▶ fetchTipAccruals (BS mode only) ────┘
```

Both legs resolve to `payroll_gl_settings.tips_chart_of_accounts_id`, an
`Other Current Liabilities` account. `lib/finance/financials/summaries.ts` sums
only `revenue`/`cogs`/`expenses`/`other_*` for P&L KPIs, so tips are excluded
**structurally** — not by a filter that can be forgotten.

## Data model

Two migrations, with **distinct numeric prefixes** — the CLI keys on the digits
before the first `_`, so two files sharing `20260823_` would collide as one
version. `20260821` is the latest on disk and **`20260822` is already claimed by
the unmerged grant-aware-RLS branch**; verify `schema_migrations` before any push.

1. `20260823_payroll_tips_account.sql` —
   `payroll_gl_settings.tips_chart_of_accounts_id uuid REFERENCES chart_of_accounts(id)`,
   seeded in the same migration to the existing `Payroll Liabilities:Undistributed Tips`
   row. Safe — nothing references that account today.
2. `20260824_payroll_gl_bucket_kind.sql` —
   `payroll_gl_report_totals.bucket_kind text NOT NULL DEFAULT 'wages'`,
   constrained to `'wages' | 'employer_tax' | 'tips'`.

`bucket_kind` is the explicit record of what an upload classified as tips versus
wages, readable straight off the totals table. It also matters mechanically: the
split math keys on it rather than comparing account ids against the setting, so
nothing breaks if the tips account is ever pointed at an account that also
receives wages.

## Payout leg

### Parser (`lib/payroll/gustoParser.ts`)

The Paycheck Tips sub-rows are already read and then discarded. Capture them
onto `ParsedGustoEmployee.paycheckTipsCents`; keep discarding Cash Tips and the
`Gross` subtotal.

`computeGlBucketTotals(parsed, departmentMap, payrollTaxesAccountId, tipsAccountId)`
gains a fourth argument, and `GlBucketTotal` gains
`kind: 'wages' | 'employer_tax' | 'tips'`. A period with zero tips emits no tips
bucket rather than a $0 row.

### Upload (`lib/payroll/gustoUpload.ts`)

Read `tips_chart_of_accounts_id` alongside the existing
`payroll_taxes_chart_of_accounts_id`. Throw a clear "configure a tips account in
settings" error if null — matching the existing route's treatment of
`payrollTaxesAccountId`, and matching the requirement that attribution be
explicit. Persist `bucket_kind` on each totals row.

### Split math (`lib/finance/payrollMatching.ts`)

`computeProportionalSplits` becomes two-stage:

1. **Exact** — each matched expense takes
   `tipsTotal × amount_i / Σamounts`, largest-remainder rounded so shares sum to
   `tipsTotal` precisely.
2. **Fill** — `amount_i − tipsShare_i` is distributed across the non-tip buckets
   by today's ratio-and-largest-remainder logic, unchanged.

Carving out the tips bucket at its exact amount **before** the pro-rata fill is
essential. Treating it as just another bucket in `periodTotals` would scale it
too: Jun 1–14 would post `$911.58 × (7943.72 / 7121.29) = $1,017`,
over-crediting the liability by the residual's share.

Invariants:

- Each expense's lines sum exactly to its own amount *(preserved)*
- Residual still absorbed by wage/tax buckets *(preserved)*
- Tips across a period's expenses sum exactly to the period tip total *(new)*

Guard: if `tipsTotal > Σamounts` (under-matched period), clamp each share to the
expense amount and flag, rather than emitting negative wage lines.

Signed output: `recomputePeriodExpenseSplits` already re-applies each expense's
cash-direction sign to the computed magnitudes; that behavior is unchanged.

## Sign convention — and an existing bug

No expense line has ever landed on a liability account, so that path is
effectively untested. For `expense`/`bank` on a balance-sheet section,
`lib/finance/financials/normalizeSign.ts` returns `-magnitude` for liabilities —
which makes a liability **grow** when you pay it down. The tips payout would
post `-$1,900` and add to what we owe instead of clearing it.

Two rows already hit this today: expenses mapped to
`Sales & Excise Taxes Payable:North Carolina Department of Revenue Payable`.

**Fix:** for `expense`/`bank` on any BS section, `return -rawCents`.

This is provably equivalent to current behavior for every case with real data:

| Case | raw | current | new |
|---|---|---|---|
| Asset purchase (outflow → asset up) | −X | +X | +X |
| Existing test `("ap", "bank", 20000)` | +20000 | −20000 | −20000 |
| **Liability paydown (outflow)** | −X | **−X** ✗ | **+X** ✓ |

It differs only where cash direction is reversed, which is the broken case, and
it fixes the NC DOR rows as a side effect.

Because this is a shared pure function on a live computation path, **freeze
`normalizeSign.test.ts` as an equivalence gate** before touching it. Expect zero
conflicts; investigate any that appear.

## Collection leg

`fetchTipAccruals(supabase, range)` in `lib/finance/financials/fetchSources.ts`:

- Sum `square_orders.tip_cents` where `invoice_id is null` (matching the taproom
  basis), grouped by month
- Emit one record per month against the tips account
- Paginate via `fetchAllRows` — PostgREST silently truncates at 1000 rows
- **Balance-sheet mode only**, the same way `openInvoiceArCents` is BS-only, so
  the P&L payload and its cost are untouched
- If the tips account is unconfigured, emit nothing rather than failing the page

A new `"tip_accrual"` member of the `NormalizeSource` union takes the
pos/invoice branch, where sign derives from the section. `other_current_liabilities`
is a negative section, so collected tips post negative (we owe more) and the
corrected payout posts positive (we owe less). BS mode is cumulative from
inception, so the line reads Σcollected − Σdisbursed.

### Expected residual balance

The balance will sit slightly credit-side rather than at zero, from two causes,
both intentional and legible:

1. **Un-netted tip refunds.** `square_refunds` stores a total `amount_cents`
   with no tip breakdown, and `square_payments` is not persisted at all
   (payments are live-fetch only), so the pooled basis — payments net of
   refunds, attributed to the original payment's day, floored at zero per
   payment (`lib/square/payroll.ts`) — cannot be reproduced from persisted
   tables. Refund netting can be added later if the drift proves material.
2. **Timing.** Tips collected near a period end are disbursed in the next one.

## Backfill

Existing `payroll_gl_report_totals` rows were written by the old parser and have
no tips bucket, so recomputing splits alone is insufficient. The backfill must:

1. Re-parse each active report's stored CSV from the `payroll-gl-reports`
   Storage bucket
2. Rewrite its totals with `bucket_kind` and a tips bucket
3. Call the existing `recomputePeriodExpenseSplits`, which already leaves
   `split_source='manual'` overrides untouched

Ships with a **dry-run mode** reporting before/after per period without writing.

Applied to prod by the orchestrator after explicit approval and a backup — never
by an implementation agent.

**Ordering constraint:** the sign fix must land before or with the backfill, or
history is rewritten with inverted signs and must be redone.

Expected effect: ~$900–$1,050 per period moves out of wage accounts into the
tips liability. May–July P&L becomes more accurate — gross margin improves,
Direct Production Labor drops. Any statement already shown to someone will
change.

## Settings UI

`app/finance/settings/payroll-department-mappings/page.tsx` gains a tips-account
picker beside the existing payroll-taxes picker, restricted to liability-type
accounts. `app/api/finance/settings/payroll-department-mappings/route.ts` reads
and writes the new column; `PUT` requires it, as it already requires
`payrollTaxesAccountId`.

**Conflict warning:** a concurrent session is consolidating the settings tabs and
will likely move this page under a combined "GL Mapping" tab. Coordinate or
rebase rather than reverting either change.

## Testing

- **`gustoParser.test.ts`** — tip rows captured; cash tips ignored; zero-tip
  period emits no bucket; unmapped-department behavior unchanged
- **`payrollMatching.test.ts`** — golden case from the real Jun 1–14 shape
  (4 debits totalling $7,943.72, tips $911.58): shares sum to exactly `91158`,
  each expense's lines sum to its own amount, residual still lands on wage/tax,
  under-matched clamp
- **`normalizeSign.test.ts`** — frozen as equivalence gate, then new liability
  cases in both directions
- **`fetchSources` / `aggregateRows`** — accrual grouping by month, BS-only
  emission, unset-account no-op
- **Reconciliation test** — June's real numbers as an end-to-end golden case

## Out of scope

- Netting tip refunds out of the accrual (see Expected residual balance)
- Cash tips as a liability — no company money moves
- Materializing accrual rows for a future QBO push
- Reclassifying the $822/period residual — force-fill retained by decision

## Known limitations carried to merge

Surfaced by the final whole-branch review. Each was assessed and deliberately
not fixed in this branch; none blocks the feature's correctness.

1. **Cash Flow operating cash shifts.** `buildFinancials.ts`'s
   `operatingCashCents` sums P&L sections only. Tips used to sit on wage/COGS
   and were counted as operating cash; they now sit on a liability section and
   are counted nowhere, so the direct-method operating cash figure reads
   ~$900/period (~$2k/month) too favorable after the backfill. Real cash did
   leave the bank. The spec guaranteed the *P&L* was untouched and delivered
   that — `cash_flow` shares the same summation and was not considered. Proper
   fix is a working-capital adjustment for balance-sheet liability movement.
2. **No under-match flag on the exact carve-out.** The clamp prevents negative
   lines, but a period where only one of several Gusto debits has been matched
   pulls the *full* period tip total out of that single partial debit and
   starves the wage fill. Pro-rata degraded gracefully here; exact carve-out
   does not. It self-corrects once the remaining debits are matched and the
   splits are recomputed, so the bad state is transient. Fix would be returning
   `{ tipsClamped, tipsShortfallCents }` and surfacing it on the recompute route.
3. **Dry-run `before` summary reads oddly.** Migration `20260824`'s
   `DEFAULT 'wages'` stamps pre-existing employer-tax rows as `wages`, so
   `before.wagesCents` includes employer tax and `before.employerTaxCents`
   reads 0. When reviewing the dry run, the assertion that matters is that the
   *total* is unchanged and `after.tips` is ~$900–$1,050 — not the apparent
   wage drop, which is mostly reclassification.
4. **Repointing the tips account strands history.** Historical splits stay on
   the old account while new accruals credit the new one, splitting the
   liability across two accounts with no migration path.
5. **`Cash on Hand` changes meaning.** The `statementSection === "bank"`
   carve-out in `normalizeSign.ts` is a second, independent correction riding
   along with this work: `cashOnHandCents` goes from a sum of *absolute* bank
   movements (meaningless) to net movement since inception (meaningful, though
   still not a reconciled balance). An improvement, but it will move visibly on
   the balance sheet and should not be discovered as a surprise.

## Deployment sequence

The merge→migration window is the real hazard: **merging this branch breaks the
Gusto upload, the payroll-match action, and the payroll-mappings settings page
until both migrations are applied.** PostgREST 400s on a missing column.

Complete break list for that window:

*Without `20260823` (`tips_chart_of_accounts_id`)* — `GET` and `PUT`
`/api/finance/settings/payroll-department-mappings` both 500, taking down the
whole settings page including the pre-existing taxes picker; `uploadGustoReport`
fails, so Gusto CSV upload is fully broken; `backfillGlReports` throws (intended).
`fetchTipsAccountId` swallows its error and returns null, so **the Financials
page never breaks** — that degradation is deliberate.

*Without `20260824` (`bucket_kind`)* — `recomputePeriodExpenseSplits` throws,
killing the recompute route, all three payroll-match call sites, and
auto-map-payroll; the payroll-match action on the Expenses tab is dead.
`uploadGustoReport`'s totals insert fails, but its existing compensating cleanup
unwinds cleanly, so there is no partial state.

Ordered steps:

1. Back up `payroll_gl_report_totals`, `expense_gl_splits`, `payroll_gl_settings`.
2. Confirm `SELECT id FROM chart_of_accounts WHERE account_name =
   'Payroll Liabilities:Undistributed Tips'` returns exactly one row — the
   migration's seed silently no-ops otherwise, leaving the column NULL and
   hard-failing every Gusto upload.
3. Verify `schema_migrations` for collisions. `20260821` and `20260822` are also
   unapplied ahead of these two, so a push applies **four** migrations, not two.
   The repo already carries 33 duplicated prefixes from earlier work and the CLI
   keys on digits before the first `_`.
4. Apply all four migrations **before or in the same maintenance window as the
   deploy** — not after.
5. Deploy. Confirm the settings page loads and shows the seeded tips account.
6. `POST /api/payroll/gl-reports/backfill` with no body (`dryRun` defaults true).
   Per period, check `after.tips` is ~$900–$1,050 and that the bucket totals sum
   to the same figure before and after. Resolve any period reporting an `error`
   before continuing — do not proceed on a partially-successful dry run.
7. `POST` with `{"dryRun": false}`. Re-check for per-period `error` strings.
8. Verify on Financials: Direct Production Labor drops, gross margin improves,
   and the tips liability sits near Σcollected − Σdisbursed (credit-side, per
   the documented refund-netting exclusion).
9. Expect and communicate the two collateral movements from Known Limitations
   above: Cash on Hand changes definition, and Cash Flow operating cash now
   excludes tip disbursements.

Verified against prod on 2026-07-28 (read-only): both migrations unapplied;
`payroll_gl_settings` holds exactly one row, so the `.single()` calls are safe;
zero manual GL split overrides (0 of 57), so the manual-override netting path is
latent; zero canceled tip-bearing orders (all 1,398 COMPLETED, $5,498.29), so the
status filter is defensive.
