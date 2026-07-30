# Balance Sheet GL Mapping — Manual Entries + Snapshot Providers

**Date:** 2026-07-30
**Status:** Approved design, pending implementation plans
**Scope:** Two sequential PRs (A then B)

---

## 1. Problem

41 of the 48 balance-sheet GL accounts render blank. This was verified by probing
every mapped source table (`pos_line_items`, `invoice_line_items`, `expenses`,
`ramp_bank_ledger`) for each balance-sheet account. Only these carry postings:

| GL | Account | Source | Count |
|---|---|---|---|
| 2220 | NC Dept of Revenue Payable | `expenses` | 4 |
| 2230 | Out Of Scope Agency Payable | `expenses` | 1 |
| 2250 | Wake County Tax Payable | `expenses` | 1 |
| 2420 | Equipment Deposits | `pos_line_items` | 6 |
| 2430 | Contract Brewing Deposits | `invoice_line_items` | 5 |

Three more are synthesized at read time and never persisted: 1100 A/R
(`injectOpenInvoiceAr` in `buildFinancials.ts`), 2310 Undistributed Tips
(`fetchTipAccruals`), and tax accruals onto 2220 and 2250 (`fetchTaxAccruals`,
via the two `square_tax_accounts` rows).

Everything else — all of Cash & Bank (1000–1040), all Inventory (1200–1240), all
Fixed Assets (1500–1590), A/P (2000), Credit Cards (2100–2110), Payroll
Liabilities (2300–2320), all Debt (2500–2600), and all Equity (3000–3400) — is
genuinely empty.

### 1.1 Root cause

The financials engine is **single-entry**. Every source row carries exactly one
`chart_of_accounts_id`. For the P&L this is sufficient: the tagged account *is*
the income or expense account. The balance sheet is the same engine with
cumulative buckets instead of monthly ones (`buildFinancials.ts:98`), so a
balance-sheet account only shows a balance when a transaction row is tagged
**directly to it**. There is no contra leg.

Consequences:

- An expense debits an expense account and credits nothing → cash, A/P and
  credit cards never move.
- A sale credits revenue and debits nothing → bank and Undeposited Funds never
  move.
- No opening balances, so anything predating the app is invisible.
- 3300 Retained Earnings is empty, and `buildTree.ts:495` has no Assets vs.
  Liabilities+Equity reconciliation — the statement cannot balance *and* does not
  say so.

Auto-mapping cannot close this gap. Auto-mapping decides *which* account a known
transaction hits. The balance-sheet gap is the other half of every entry, plus
stocks that were never transactions in this app at all.

### 1.2 No month-over-month exists

`cumulativeRange` collapses every record onto one synthetic month key and
`collapseDates` flattens dates (`fetchSources.ts:152`). The P&L renders 12
columns; the balance sheet renders a **single Total column**. Month-over-month is
a missing feature, not a refinement.

### 1.3 Manual entries are in the wrong place and not auditable

`manual_net_sales_entries` (used for pre-Square Arryved historical data) lives
under **Taproom Management > Targets > Manual Entries**, is gated on
`CAP.targetsEdit` (a taproom capability), and has **no `created_by` column at
all** — zero audit trail. Its `injectManualNetSales` consumer synthesizes a row
with `coaId: null`, which `buildDataQuality` then has to special-case by table
name so it doesn't read as a mapping oversight.

---

## 2. Chosen approach

**Balance-provider snapshots.** Each balance-sheet account declares how its
period-end balance is produced — derived from app data, pulled from an
integration, or entered manually. Balances are snapshotted per month into a table
the statement reads, which yields month-over-month columns as a direct
consequence.

Rejected alternatives:

- **Full double-entry ledger** (`gl_entries`, every source row posts 2+ legs).
  Correct by construction and self-balancing, but a rebuild of the posting engine
  plus a backfill of every historical transaction, duplicating what QuickBooks
  already does. This app is management reporting; QuickBooks remains the book of
  record (`qb_sync_status`, `qb_remote_id`).
- **Hybrid contra-legs for cash only.** Smaller than full double-entry but still
  touches the aggregation engine, and delivers partial balancing that reads as
  more trustworthy than it is.

### 2.1 What diverges and what stays shared

Only the row-sourcing stage splits. The rest of the pipeline is untouched.

| Stage | P&L | Balance Sheet |
|---|---|---|
| Row source | transactions | **balances (new)** |
| `FinancialsRow` shape | shared | shared |
| Sign normalization (`normalizeSign.ts`) | shared | shared |
| `buildTree` sections/subtotals | shared | shared |
| `FinancialsTable`, page shell, KPI strip | shared | shared |

The justification is semantic, not architectural: **a P&L account is a sum of
things that happened; a balance-sheet account is an amount that exists.** Nothing
in this app transacts into "Chase Operating Account", which is precisely why
summing transactions leaves it blank.

The first provider, `transactionPostings`, *is* today's logic wrapped as a
provider — existing behavior gets a name rather than being abandoned.

### 2.2 Sign convention — verified, and not what it looks like

`normalizeSign.ts:30-39` places `ap`, `credit_card`, `other_current_liabilities`,
`long_term_liabilities` and `equity` in **`NEGATIVE_SECTIONS`**, and nothing
flips it for display. Verified against production data:

| Posting | Raw cents | Normalized | Reads as |
|---|---|---|---|
| 2420 deposits collected (`pos`) | +24,000 | **−24,000** | a liability owed shows *negative* |
| 2220 tax payments (`expense`) | −395,483 | **+395,483** | paying it down shows *positive* |

So the balance identity in this codebase's stored space is:

```
Total Assets + Total Liabilities + Equity = 0
```

**Snapshots store this internal convention** — assets positive, liabilities and
equity negative — so that a snapshot is interchangeable with the aggregated
`FinancialsRow` values it replaces, and the equivalence gate (§4.9) is
meaningful. Contra-accounts invert accordingly (1590 Accumulated Depreciation is
a negative asset).

Presentation is corrected separately at the `buildTree` layer (§4.5) so the
rendered statement reads conventionally.

> Observed while verifying: 2220 currently renders **+$3,954.83** — accumulated
> tax *payments* with no accrual offset, because `square_tax_accounts`
> (migration 20260827) is not applied in prod. A liability reading positive is
> the symptom, and it corroborates the known tax-GL-model gap.

---

## 3. PR A — Manual Entries in Finance > Transactions

Manual entries become auditable finance records in the section that owns them.
**Settings holds rules; Transactions holds values.** This PR ships independently
and carries no balance-sheet risk.

### 3.1 Data model — `supabase/migrations/20260904120000_manual_entries.sql`

```sql
create table manual_entries (
  id                    uuid primary key default gen_random_uuid(),
  entry_kind            text   not null check (entry_kind in ('flow','balance')),
  chart_of_accounts_id  uuid   not null references chart_of_accounts(id),
  start_date            date,          -- flow only
  end_date              date,          -- flow only
  as_of_date            date,          -- balance only, always a month end
  amount_cents          bigint not null,
  label                 text,
  note                  text,
  mapping_source        text   not null default 'manual',
  qb_remote_id          text,
  qb_sync_status        text,
  qb_synced_at          timestamptz,
  created_at            timestamptz not null default now(),
  created_by            uuid references auth.users(id),
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users(id),

  constraint manual_entries_kind_dates check (
    (entry_kind = 'flow'
       and start_date is not null and end_date is not null
       and as_of_date is null and start_date <= end_date)
    or
    (entry_kind = 'balance'
       and as_of_date is not null
       and start_date is null and end_date is null
       and as_of_date = (date_trunc('month', as_of_date) + interval '1 month - 1 day')::date)
  )
);

-- One balance per account per period is a database guarantee, so a correction
-- is an UPDATE with history in audit_log, never a duplicate row.
create unique index manual_entries_one_balance_per_period
  on manual_entries (chart_of_accounts_id, as_of_date)
  where entry_kind = 'balance';

create index manual_entries_coa_kind on manual_entries (chart_of_accounts_id, entry_kind);

-- Reuse the existing generic audit trigger (supabase/migrations/20260609_baseline.sql:408).
create trigger manual_entries_audit
  after insert or update or delete on manual_entries
  for each row execute function audit_trigger_fn();
```

RLS follows the grant-aware policy pattern established in
`20260822_rls_grant_aware_policies.sql`.

**The `as_of_date` month-end CHECK is load-bearing:** the snapshot layer only
ever reads balances keyed to a month end, so a mid-month value would be silently
invisible. The database rejects it instead.

### 3.2 Flow vs. balance

| | Flow | Balance |
|---|---|---|
| Example | "Arryved historical net sales, May 1–15" | "Chase balance at 7/31 = $84,120" |
| Dates | `start_date`/`end_date`, prorated by day overlap | `as_of_date`, replaces |
| Consumed by | P&L (`injectManualNetSales`) | Balance Sheet (`manualBalance` provider, PR B) |

### 3.3 Data migration

The two existing `manual_net_sales_entries` rows migrate in as
`entry_kind='flow'` with `chart_of_accounts_id` = the account whose
`account_number` is `4100` (`BREWERY REVENUE:Taproom Revenue`) — the aggregate
taproom-revenue parent, matching what these plugs represent. `created_by` is left
null for migrated rows (the source table never recorded it; backfilling a guess
would be worse than an honest null).

`manual_net_sales_entries` is dropped in the same migration after the copy.

### 3.4 File map

**New**

| File | Purpose |
|---|---|
| `supabase/migrations/20260904120000_manual_entries.sql` | schema, audit trigger, RLS, data migration, drop old table |
| `lib/finance/manualEntries.ts` | types + pure validators |
| `lib/finance/manualEntries.test.ts` | validator tests |
| `app/api/finance/manual-entries/route.ts` | GET/POST/PATCH/DELETE |
| `app/finance/transactions/manual-entries/page.tsx` | the new fifth subtab |

**Modified**

| File | Change |
|---|---|
| `app/finance/transactions/TransactionsNav.tsx` | add the Manual Entries tab |
| `lib/finance/financials/fetchSources.ts` | read `manual_entries` where `entry_kind='flow'` |
| `lib/finance/financials/manualNetSales.ts` | `ManualNetSalesEntryRecord` gains `chartOfAccountsId`; synthesized row uses the real `coaId` and derives `statementSection` via `coaSection` instead of hardcoding `"revenue"` |
| `lib/finance/financials/summaries.ts` | remove the `manual_net_sales_entries` table-name exclusion in `buildDataQuality` — a real `coaId` means the row is no longer unmapped |
| `lib/query-keys.ts` | add `finance.manualEntries` |
| `app/taproom/nav-config.ts` | remove line 25 (`/taproom/targets/manual-entries`) |

**Deleted**

- `app/taproom/targets/manual-entries/` (directory)
- `app/taproom/components/ManualEntriesTab.tsx`
- `app/api/manual-entries/route.ts`

Taproom > Targets keeps Achievement and Target Setting.

### 3.5 Interfaces

```ts
// lib/finance/manualEntries.ts
export type ManualEntryKind = "flow" | "balance";

export interface ManualEntryRecord {
  id: string;
  entryKind: ManualEntryKind;
  chartOfAccountsId: string;
  startDate: string | null;
  endDate: string | null;
  asOfDate: string | null;
  amountCents: number;
  label: string | null;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export type ManualEntryInput =
  | { entryKind: "flow";    chartOfAccountsId: string; startDate: string; endDate: string; amountCents: number; label?: string | null; note?: string | null }
  | { entryKind: "balance"; chartOfAccountsId: string; asOfDate: string;                    amountCents: number; label?: string | null; note?: string | null };

/**
 * Mirrors the DB CHECK so the API returns a 400 with a readable message before
 * Postgres raises 23514. Same predicate, two enforcement points on purpose.
 */
export function validateManualEntry(input: ManualEntryInput): { ok: true } | { ok: false; error: string };

/** Last calendar day of the month containing `date` ("YYYY-MM-DD" in, same out). */
export function monthEnd(date: string): string;
```

### 3.6 Permissions

All reads gated on `CAP.financeTransactionsRead`; all writes on
`CAP.financeTransactionsManage`. This is a deliberate change from
`CAP.targetsEdit`: manual entries are finance records. Anyone who manages taproom
targets without finance access loses the ability to enter net-sales plugs, which
is the intended outcome.

### 3.7 UI

`app/finance/transactions/manual-entries/page.tsx` follows the existing
transactions-subtab conventions and reuses `app/finance/transactions/components/`:
`DateRangeFilter`, `GlAccountFilter`, `Pagination`, `SummaryStatBar`,
`LedgerTable`. Per `docs/UI_STANDARD.md`: `<Card>`, `.inp`, `.btn-primary`,
`<Badge tone>`, `<Modal>`/`<Field>` for the add/edit form, `<Banner>` for errors.
No raw colors, no hand-rolled primitives.

The list shows entry kind as a `<Badge>`, the account, the date or date range,
amount, label, and who last touched it. Flow rows display the per-day prorated
figure the way the current taproom tab does.

### 3.8 Tests

- `validateManualEntry`: each CHECK branch — flow missing `endDate`, flow with
  `asOfDate` set, balance with a date range, balance whose `asOfDate` is not a
  month end, `startDate > endDate`, non-integer/zero amounts.
- `monthEnd`: January, February in a leap year and a non-leap year, December.
- `manualNetSales.test.ts`: existing proration tests must still pass unchanged
  (the math does not move); add a case asserting the synthesized row now carries
  a real `coaId` and a `coaSection`-derived `statementSection`.
- `summaries.test.ts`: a manual flow entry is no longer counted in the unmapped
  bucket.

---

## 4. PR B — Balance-sheet snapshots + month-end close

Depends on PR A for the `manualBalance` provider's data source.

### 4.1 Data model — `supabase/migrations/20260904130000_balance_sheet_snapshots.sql`

```sql
-- The "auto-mapping" rule table. An account may declare MORE THAN ONE source:
-- a liability is typically accrued by one mechanism and settled by another
-- (2220 = tax collections + tax payments). The composite key is deliberate.
create table balance_sheet_account_sources (
  chart_of_accounts_id  uuid    not null references chart_of_accounts(id) on delete cascade,
  provider_key          text    not null,
  config                jsonb   not null default '{}',
  active                boolean not null default true,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users(id),
  primary key (chart_of_accounts_id, provider_key)
);

-- The computed snapshot, uniform across every provider kind.
create table gl_account_balances (
  id                    uuid   primary key default gen_random_uuid(),
  chart_of_accounts_id  uuid   not null references chart_of_accounts(id),
  period_end            date   not null,
  balance_cents         bigint not null,   -- internal convention (§2.2); sum of contributions
  -- {"taxAccrual": -423100, "transactionPostings": 395483} -- makes a balance
  -- explainable in the UI and a wrong balance debuggable.
  contributions         jsonb  not null default '{}',
  is_frozen             boolean not null default false,
  computed_at           timestamptz not null default now(),
  unique (chart_of_accounts_id, period_end)
);

-- Mirrors tax_tasks 1:1.
create table balance_close_tasks (
  id                    uuid primary key default gen_random_uuid(),
  chart_of_accounts_id  uuid not null references chart_of_accounts(id),
  period_end            date not null,
  due_date              date not null,
  status                text not null default 'open' check (status in ('open','completed','skipped')),
  alert_sent_at         timestamptz,
  completed_at          timestamptz,
  notes                 text,
  created_at            timestamptz not null default now(),
  unique (chart_of_accounts_id, period_end)
);
```

Close configuration lives in `system_settings` under key `balance_sheet_close` →
`{ "due_day": 5, "alert_lead_days": 0 }`. No fourth table.

**Seed rows are mandatory, not optional.** The migration inserts
`balance_sheet_account_sources` rows for every account that currently produces a
number, or that behavior silently disappears on deploy. The seed below was
derived by querying production, not assumed:

| Account | Providers | Why |
|---|---|---|
| 2220 NC DOR Payable | `taxAccrual` **+** `transactionPostings` | `square_tax_accounts` maps "General Sales Tax" here; 4 expense payments also post here |
| 2250 Wake County Tax Payable | `taxAccrual` **+** `transactionPostings` | `square_tax_accounts` maps "Prepared Food & Beverage Tax" here; 1 expense payment also posts here |
| 2230 Out Of Scope Agency Payable | `transactionPostings` | 1 expense |
| 2420 Equipment Deposits | `transactionPostings` | 6 POS lines |
| 2430 Contract Brewing Deposits | `transactionPostings` | 5 invoice lines |
| 1100 Accounts Receivable | `openInvoiceAr` | today's `injectOpenInvoiceAr` |
| 2310 Undistributed Tips | `tipAccrual` | today's `fetchTipAccruals` |
| 3300 Retained Earnings | `retainedEarnings` | new |

2210, 2240 and 2260 are **deliberately left unsourced** — no `square_tax_accounts`
row points at them and they carry no postings. Seeding them with `taxAccrual`
would manufacture a source that computes to nothing and hide them from the
`unsourcedAccounts` tile.

### 4.2 Provider registry

Mirrors `lib/tax/registry.ts` plus the `lib/tax/parties` side-effect registration
idiom (`import "@/lib/finance/balances/providers"` for its registration effect).

```ts
// lib/finance/balances/registry.ts
export type ProviderKind = "derived" | "integration" | "manual";

export interface BalanceContext {
  supabase: AdminClient;
  /** "YYYY-MM-DD", always a month end. */
  periodEnd: string;
  coaId: string;
  config: Record<string, unknown>;
}

export interface BalanceProvider {
  key: string;
  label: string;
  kind: ProviderKind;
  /** Filters which accounts this provider is offerable for in the Settings dropdown. */
  appliesTo?: (coa: CoaAccountRef) => boolean;
  /** Display-normalized cents, or null when the balance cannot be determined. */
  compute(ctx: BalanceContext): Promise<number | null>;
}

export function registerProvider(p: BalanceProvider): void;
export function getProvider(key: string): BalanceProvider | undefined;
export function listProviders(): BalanceProvider[];
```

### 4.3 Providers in this PR

| Key | Kind | Accounts | Origin |
|---|---|---|---|
| `transactionPostings` | derived | any BS account | today's direct-tag logic, wrapped |
| `openInvoiceAr` | derived | 1100 | **moved** from `injectOpenInvoiceAr` |
| `tipAccrual` | derived | 2310 | **moved** from `fetchTipAccruals` |
| `taxAccrual` | derived | 2220, 2250 | **moved** from `fetchTaxAccruals` |
| `retainedEarnings` | derived | 3300 | new |
| `manualBalance` | manual | any BS account | new; reads `manual_entries` |

The three moved providers keep their math verbatim and are only re-parameterized
from a single canonical month to an arbitrary `periodEnd`. They live together in
`providers/accruals.ts` because they are siblings in `fetchSources.ts` today.

`retainedEarnings` computes cumulative P&L net income through `periodEnd` by
reusing `aggregateRows` over cumulative sources, so it cannot drift from the P&L.
It is deliberately **one number** — 3300 only — with no separate current-year
earnings line, since the CoA has no such account. Splitting it is deferred.

`manualBalance` reads `manual_entries` where `entry_kind='balance'` and
`as_of_date = periodEnd`, returning null when absent. This is the simplification
PR A's model enables: there is no manual special case anywhere in the snapshot
layer — every provider computes.

**Graceful degradation is preserved.** `taxAccrual` depends on
`square_tax_accounts` (migration 20260827) and `tipAccrual` on
`payroll_gl_settings.tips_chart_of_accounts_id` (20260823). Both currently
degrade to silence on a missing table/column and must continue to. Their seeded
source rows will compute to nothing until those migrations land in prod.

### 4.4 Snapshot service

```ts
// lib/finance/balances/snapshot.ts
export interface SnapshotResult { written: number; skipped: number; errors: string[] }

export async function snapshotPeriod(supabase: AdminClient, periodEnd: string): Promise<SnapshotResult>;
export async function fetchBalances(supabase: SupabaseClient, months: string[]): Promise<Map<string, Record<string, number>>>;
export async function freezePeriod(supabase: AdminClient, periodEnd: string): Promise<void>;

/**
 * Pure decision layer, unit-tested independently of IO. Results are keyed
 * `${coaId}:${providerKey}` because an account may have several sources.
 */
export function resolveSnapshotWrites(
  sources: { coaId: string; providerKey: string }[],
  results: Map<string, number | null>,
  existing: Map<string, { isFrozen: boolean }>,
): { coaId: string; balanceCents: number; contributions: Record<string, number> }[];
```

Rules:

- Never write a frozen row.
- **Sum** every active provider's non-null result for an account; record each
  contribution by provider key.
- An account whose providers all return null produces **no snapshot row** — it
  reads as unsourced rather than as a spurious $0.
- **Update in place** while a month is open — deliberately unlike `autoMap.ts`'s
  fill-nulls-only convention, because a derived balance must stay recomputable
  until close.

### 4.5 Read path — where month-over-month appears

In `buildFinancials.ts`, the `balance_sheet` branch stops calling
`cumulativeRange`/`collapseDates` and instead reads `fetchBalances()` for the
trailing 12 months of `year`, emitting one `FinancialsRow` per account with a
populated `amountCentsByMonth`. The current open month computes live from
providers so the statement is not stale mid-month; closed months read their
frozen snapshot.

`cumulativeRange` and `collapseDates` are balance-sheet-only and are deleted
along with the three accrual fetchers that move to providers.

#### Presentation sign fix

`buildBalanceSheet` applies a **display flip** to the `ap`, `credit_card`,
`other_current_liabilities`, `long_term_liabilities` and `equity` sections so the
rendered statement reads conventionally — `Assets = Liabilities + Equity` — as
every balance sheet does.

```ts
/** Balance-sheet presentation only: negate the credit-side sections so
 *  liabilities and equity render positive. Applied at the tree layer, after
 *  every sum, so stored snapshots and normalizeSign.ts keep the internal
 *  convention (§2.2) and the P&L is untouched. */
function toPresentationSign(node: TreeNode, section: string): TreeNode;
```

This is scoped to `buildBalanceSheet` alone. `normalizeSign.ts` is shared with
the P&L and is **not** modified.

|  | Today | After |
|---|---|---|
| Total Assets | 412,880 | 412,880 |
| Equipment Deposits | −240 | **240** |
| NC DOR Payable | 3,955 | **−3,955** |
| Total Liabilities + Equity | −398,105 | **398,105** |

#### Balancing Difference

`buildBalanceSheet` gains a **Balancing Difference** row after Total Liabilities
+ Equity. In the internal convention (§2.2) the variance is
`totalAssets + totalLiabEquity`; after the presentation flip it is the familiar
`totalAssets − totalLiabEquity`. **Both expressions are the same number** — the
row is computed once, post-flip, so there is a single formula in the code.

`buildDataQuality` gains an `unsourcedAccounts` tile counting balance-sheet
accounts with no active source. The variance shrinking toward zero is the
progress metric as providers are added in later PRs.

### 4.6 Close workflow

`lib/finance/balances/closeTasks.ts` mirrors `lib/tax/tasks.ts`:

```ts
export async function ensureTasksForPeriod(supabase: AdminClient, periodEnd: string): Promise<number>;
export function tasksNeedingAlert(tasks: CloseTask[], today: string, leadDays: number): CloseTask[];  // pure
export async function markAlerted(supabase: AdminClient, ids: string[]): Promise<void>;
/** Closes any task whose corresponding manual_entries balance row now exists. */
export async function reconcileCloseTasks(supabase: AdminClient, periodEnd: string): Promise<number>;
export function isPeriodClosed(tasks: CloseTask[]): boolean;  // pure
```

`ensureTasksForPeriod` creates one task per active `manualBalance`-sourced
account that has no `manual_entries` balance row for that `period_end`, upserting
on `(chart_of_accounts_id, period_end)` with `ignoreDuplicates`.

**Tasks are never manually completed.** They close when the balance entry
appears. PR A's `POST /api/finance/manual-entries` calls `reconcileCloseTasks`
after inserting a balance, so the task closes immediately; the cron reconciles as
a backstop. The user's workflow is: receive email → follow the link to Finance >
Transactions > Manual Entries → enter the balance → done.

New `app/api/cron/balance-close/route.ts`, wrapped in `runCronJob` like the other
five crons, scheduled `0 9 * * *` in `vercel.json` — after `finance-sync` (07:30)
so it snapshots post-ingest. Each run, for the most recently ended month:
`ensureTasksForPeriod` → `snapshotPeriod` → `reconcileCloseTasks` → alert via
`renderBalanceCloseEmail` + `sendEmail`/`ADMIN_EMAIL` → `freezePeriod` once
closed or past `due_date`.

### 4.7 File map

**New**

| File | Purpose |
|---|---|
| `supabase/migrations/20260904130000_balance_sheet_snapshots.sql` | 3 tables, RLS, seed source rows |
| `lib/finance/balances/registry.ts` | provider interface + registry |
| `lib/finance/balances/snapshot.ts` | compute/store/freeze + pure `resolveSnapshotWrites` |
| `lib/finance/balances/closeTasks.ts` | month-end task lifecycle |
| `lib/finance/balances/alertEmail.ts` | mirrors `lib/tax/alertEmail.ts` |
| `lib/finance/balances/providers/index.ts` | registration barrel |
| `lib/finance/balances/providers/transactionPostings.ts` | today's logic, wrapped |
| `lib/finance/balances/providers/accruals.ts` | the three moved accrual providers |
| `lib/finance/balances/providers/retainedEarnings.ts` | cumulative net income |
| `lib/finance/balances/providers/manualBalance.ts` | reads `manual_entries` |
| `app/api/finance/balance-sources/route.ts` | GET/PUT provider rules |
| `app/api/finance/balance-close/route.ts` | GET tasks for a period |
| `app/api/cron/balance-close/route.ts` | daily cron |
| `app/settings/finance/balance-sheet-accounts/page.tsx` | provider rule editor |

Plus co-located tests: `registry.test.ts`, `snapshot.test.ts`,
`closeTasks.test.ts`, `accruals.test.ts`, `retainedEarnings.test.ts`.

No new *read* route — the balance sheet keeps using `/api/finance/financials`.

**Modified**

| File | Change |
|---|---|
| `lib/finance/financials/fetchSources.ts` | delete BS branch, `cumulativeRange`, `collapseDates`, the three accrual fetchers |
| `lib/finance/financials/buildFinancials.ts` | BS branch reads `fetchBalances`; delete `injectOpenInvoiceAr` |
| `app/finance/financials/buildTree.ts` | presentation sign flip + Balancing Difference row |
| `lib/finance/financials/summaries.ts` | `unsourcedAccounts` tile |
| `app/finance/financials/DataQualityPanel.tsx` | render the tile |
| `app/finance/financials/page.tsx` | open-close `<Banner>` |
| `app/api/finance/manual-entries/route.ts` | call `reconcileCloseTasks` after a balance write |
| `app/settings/nav-config.ts` | add the Balance Sheet Accounts subtab |
| `vercel.json` | add the cron |
| `lib/query-keys.ts` | add `finance.balanceSources`, `finance.balanceClose` |

### 4.8 UI

`app/settings/finance/balance-sheet-accounts/page.tsx` follows
`app/settings/finance/sales-tax-accounts/page.tsx` as its template. One row per
balance-sheet account showing account name and number, its **list** of configured
sources (an account may have several — §4.1), an add-source control whose
`<select>` is filtered by `appliesTo`, per-source config and active toggle, and a
read-only "current balance / as of" column that breaks out `contributions` per
provider.

**No editable dollar values on this screen** — a manual account's row deep-links
to Finance > Transactions > Manual Entries instead. Settings holds rules;
Transactions holds values.

Gated on `CAP.financeTransactionsManage`.

### 4.9 Tests

- `registry.test.ts`: registration, lookup, duplicate-key rejection, `appliesTo`
  filtering.
- `snapshot.test.ts`: `resolveSnapshotWrites` — frozen rows skipped; an account
  with two providers sums both and records both contributions; one provider
  returning null still writes the other's value; **all** providers null writes no
  row at all; existing rows updated in place; unknown provider key.
- `closeTasks.test.ts`: `ensureTasksForPeriod` idempotency, `tasksNeedingAlert`
  boundary days (day before / day of / day after the lead threshold),
  `isPeriodClosed` with mixed statuses, `reconcileCloseTasks` closing only tasks
  whose entry exists.
- Per-provider pure math tests.
- `buildTree.test.ts`: the presentation flip negates exactly the five credit-side
  sections and leaves asset sections and every P&L tree untouched; Balancing
  Difference row arithmetic, including when a section is entirely absent.
  Existing `buildTree` balance-sheet assertions carry the old signs and **must be
  updated as part of this change** — that update is the visible proof the flip
  landed, not incidental churn.
- **Equivalence gate.** Freeze today's Total-column values for 1100, 2220, 2230,
  2250, 2310, 2420 and 2430 into a fixture and assert the provider path
  reproduces them for that month — with the flip applied, since presentation
  changes sign but must not change magnitude. The four provider "moves" plus the
  sign flip are exactly where silent drift would hide, and per
  `feedback_frozen_tests_as_equivalence_gate` a fixture that does not match
  production can hide the bug entirely — so this fixture is built from real
  queried values, not invented ones.

---

## 5. Deferred

Explicitly out of scope for both PRs, each a candidate follow-up:

| Item | Accounts | Blocker |
|---|---|---|
| Inventory: raw materials | 1210 | none — `ingredients.stock_quantity × cost_per_unit` |
| Inventory: packaging | 1220 | none — `packaging_items.stock_quantity × unit_cost` |
| Inventory: merchandise | 1240 | Square carries no cost basis; needs manual cost per SKU |
| Inventory: finished goods | 1230 | **no per-batch costing model exists**; `cold_storage_inventory` is quantity only |
| Ramp card balance | 2110 | none — `getRampStatements()` already returns `ending_balance` |
| Ramp operating balance | 1030 | needs a starting balance plus flows, or a Ramp balance endpoint |
| Square deposits / undeposited funds | 1040, 1400 | **no Square Payouts module exists** in `lib/square/` |
| Gift card liabilities | 2410 | no Square gift-card integration |
| Payroll tax payable | 2320 | `payroll_gl_report_totals` has the data; just needs a provider |
| Fixed-asset register + depreciation | 1500–1590 | no asset-register table; manual until built |
| Current-year-earnings split | 3300 | CoA has no separate Net Income equity account |

---

## 6. Observations logged, not addressed here

- **Duplicate `account_number` 4999.** Two accounts share it (`Unapplied Cash
  Payment Income` and `Sales Returns & Refunds`). Harmless for this design —
  every table and provider keys on `chart_of_accounts_id` (uuid), never on
  `account_number` — but worth cleaning up separately.
- **Unapplied migrations in prod.** Per project memory, several migrations from
  20260802 onward have not been applied. `taxAccrual` and `tipAccrual` depend on
  20260827 and 20260823 respectively and will compute to nothing until those
  land. Both degrade silently by design; the `unsourcedAccounts` tile will not
  flag them because a source row *is* configured. This is a known, accepted gap.
