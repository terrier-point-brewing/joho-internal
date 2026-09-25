---
name: project_balance_sheet_gl_mapping
description: "Balance sheet GL population — PR A #300 and PR B #310 both merged+applied; cleanup #312 open; NEVER seen in a browser"
metadata: 
  node_type: memory
  type: project
  originSessionId: e49d81a1-294a-41a5-9d88-81d47b414a19
  modified: 2026-07-30T20:20:16.394Z
---

**The problem (audited 2026-07-30):** 41 of 48 balance-sheet GL accounts render
blank. Root cause is that the financials engine is **single-entry** — every source
row carries one `chart_of_accounts_id`, and the balance sheet is the P&L engine
with cumulative buckets, so an account only shows a balance if a transaction is
tagged directly to it. No contra leg, no opening balances, no retained earnings.
Auto-mapping cannot fix this: it decides *which* account a transaction hits, while
the gap is the other half of every entry. The BS also renders a **single Total
column** — no month-over-month exists.

**Chosen approach:** per-account balance *providers* feeding a monthly snapshot
table. Rejected full double-entry (rebuild of the posting engine; QuickBooks
remains the book of record).

Spec: `docs/superpowers/specs/2026-07-30-balance-sheet-gl-mapping-design.md`

## ✅ PR A — Manual Entries (#300, MERGED + APPLIED 2026-07-30)

`manual_entries` table (`flow` = prorated date range → P&L; `balance` = month-end
`as_of_date` → Balance Sheet), Finance > Transactions subtab, audit trigger,
`manual_net_sales_entries` migrated onto GL 4100 and dropped. Verified in prod:
2 flow rows, amounts 1346800/891300 preserved, old table gone.

⚠️ **Never seen in a browser** — login wall. The blocker review caught rendered as
a plausible empty state, which is exactly the failure mode a browser check finds.

Open decisions, neither blocking:
- `manual_entries.chart_of_accounts_id` is `NOT NULL` + `NO ACTION`, while every
  other CoA FK is `ON DELETE SET NULL`. The CoA CSV bulk re-sync deletes by
  omission, so re-uploading a chart omitting 4100 fails 23503 and applies nothing.
- `coa_reference_count` has no `manual_entries` arm — see [[project_coa_reference_count_broken]].

## ✅ PR B — Snapshot providers + month-end close (#310, MERGED + APPLIED 2026-07-31)

Plan: `docs/superpowers/plans/2026-07-30-balance-sheet-snapshots-close.md`
Migration applied: `20260905100000_balance_sheet_snapshots.sql` (re-stamped from 20260904130000 so it sorts AFTER the coa_reference_count repair, which was merged but still pending at the time)

Three tables (`balance_sheet_account_sources` keyed **(account, provider)** — an
account needs several providers, e.g. 2220 = tax accruals + tax payments;
`gl_account_balances`; `balance_close_tasks`), six providers (four are *moves* of
logic in `fetchSources.ts`/`buildFinancials.ts`), MoM columns, a presentation sign
flip, a Balancing Difference row, and a daily close cron with Resend alerts.

**Two facts PR B depends on, both verified against prod, both easy to get wrong:**
- **Sign convention is inverted from intuition.** `normalizeSign.ts:30-39` puts
  liabilities and equity in `NEGATIVE_SECTIONS` and nothing flips it for display,
  so the stored identity is `Assets + Liabilities + Equity = 0` and the statement
  currently renders liabilities backwards. Snapshots store that internal
  convention; presentation flips at the `buildTree` layer only.
- RLS on the three new tables must not use the grant applicator alone —
  see [[feedback_apply_grant_policies_additive_only]].

Deferred beyond PR B: inventory providers (1210/1220/1240), batch costing for
1230 Finished Goods (no per-batch cost model exists), Square Payouts for
1040/1400 (no module in `lib/square/`), Ramp balances for 1030/2110
(`getRampStatements()` already returns `ending_balance`), gift cards 2410,
payroll tax payable 2320, fixed-asset register 1500-1590.

## PR B outcome (merged 2026-07-31, migration 20260905100000 applied)

Verified live: 13 seed rows, close config present, coa_reference_count has the
3 new arms, snapshotPeriod written=8 skipped=1 errors=0, fetchBalances read
back 8. Parity against a fresh capture of the OLD pipeline: all 9 accounts
match, diverge-as-designed, or are introduced-by-design.

⚠️ **STILL NEVER SEEN IN A BROWSER.** Across both PRs, three of four Critical
defects rendered as plausible EMPTY STATES, not errors — an empty settings
screen, a blank subtab, blank accounts. That is the failure mode a test suite
structurally cannot catch and the dominant one in this feature.

Two live corrections landed with it: liabilities/equity now render positive
(they were showing raw internal signs), and GL 2310 dropped 296,802 to its true
cumulative value — the old balance sheet counted tip PAYOUTS current-month-only
while counting COLLECTIONS cumulatively.

Retained Earnings appears for the first time at $28,811.50 (stored -2,881,150).
Worth checking against the books — it is the one figure with no old value to
compare against.

Review cost two NOT-READY rounds. Round 2's findings were all things a
self-review is positioned to miss: fixes applied at the symptom site rather than
the defect class, and verification shaped to the fix (a hand-rolled parity probe
omitted GL 3300 and was reported as clean). The equivalence gate itself was
retired in #312 — see that PR for what it caught.

Deferred, unchanged: inventory providers 1210/1220/1240, batch costing for 1230,
Square Payouts 1040/1400, Ramp balances 1030/2110, gift cards 2410, payroll tax
payable 2320, fixed-asset register 1500-1590. Nothing seeds manualBalance, so
the close workflow stays dormant and the remaining blank accounts stay blank
until sources are configured by hand in Settings > Finance > Balance Sheet
Accounts.
