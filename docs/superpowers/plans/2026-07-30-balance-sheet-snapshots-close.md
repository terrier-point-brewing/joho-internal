# PR B — Balance Sheet Snapshots + Month-End Close — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every balance-sheet GL account a declared source, snapshot those balances monthly so the statement renders month-over-month, present liabilities and equity conventionally, surface the out-of-balance variance honestly, and nag the user by email when a manual balance is missing at month end.

**Execution Budget:** subagent-driven-development · **Spawn cap = 20** · target ≈ 320k tokens. STOP and report before exceeding the cap.

> The cap is NOT `locality groups + 2`. PR A used that formula, budgeted 7, and
> spent ~14: the SDD loop costs an implementer **plus** a reviewer per task, and
> 2 more whenever a review returns findings (fixer + re-review). Two of PR A's
> five tasks needed a fix pass, and one of those caught a Critical defect — so
> the loop is load-bearing, not waste. Budget ≈ 3 × tasks, + 1 for the final
> whole-branch review.

**Architecture:** Each balance-sheet account declares one *or more* balance providers in a rule table. A daily cron computes every provider for the just-ended month and writes a summed snapshot with per-provider contributions. The balance sheet reads snapshots for closed months and computes live for the open month. Four of the six providers are *moves* of logic that lives in `fetchSources.ts`/`buildFinancials.ts` today, so an equivalence gate against real production values guards the migration.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, Supabase Postgres, TanStack Query, Resend, Vercel Cron, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-30-balance-sheet-gl-mapping-design.md` §4

**Depends on:** PR A (`docs/superpowers/plans/2026-07-30-manual-entries-finance-transactions.md`) — the `manualBalance` provider reads `manual_entries`. Do not start this plan until PR A is merged and its migration applied.

## Global Constraints

- **No full implementation bodies in this plan.** Per `CLAUDE.md`, plans specify file maps, interfaces, signatures, acceptance criteria and test cases. Inline code appears only for genuinely non-obvious logic, capped at ~20 lines per task. This overrides the writing-plans skill's "complete code in every step" default.
- **Sign convention (spec §2.2), verified against production — get this wrong and every number is wrong.** `normalizeSign.ts:30-39` places `ap`, `credit_card`, `other_current_liabilities`, `long_term_liabilities` and `equity` in `NEGATIVE_SECTIONS`. **Stored** balances (snapshots, provider return values) use that internal convention: assets positive, liabilities and equity negative, so the identity is `Assets + Liabilities + Equity = 0`. **Presentation** flips the credit side at the `buildTree` layer only (Task 4). Never change `normalizeSign.ts` — it is shared with the P&L.
- **Every new/modified `lib/` module ships a co-located `*.test.ts`.** Do not drop `lib/` coverage below the `vitest.config.ts` threshold floor.
- **DoD command:** `npm run verify` must pass before each commit.
- **UI:** `docs/UI_STANDARD.md` is binding — token utilities only, shared primitives only. Same rules as PR A.
- **Auth:** reads `CAP.financeStatementsRead`; provider-rule writes `CAP.financeTransactionsManage`.
- **RLS — this exact mistake shipped a blocker in PR A; it is waiting for all three of this PR's tables.** `apply_grant_policies(table, scope)` is **ADDITIVE-ONLY**. Its predicate bottoms out in `effective_grant_level()`, which carries `and get_my_role() = 'custom'` (`20260822_rls_grant_aware_policies.sql:54`), so on its own it denies every `viewer`/`brewer`/`manager`/`admin`. On the payroll tables it was always layered over an existing role policy; a NEW table that gets only the grant pair matches **no policy for any real user**. A SELECT matching no policy returns **zero rows with no error** — it renders as a plausible empty state and silently zeroes any figure computed from it. Pair it with a role policy, or lock the table down and read via `createSupabaseAdminClient()` behind `requirePermission` (the `chart-of-accounts` / `expenses` pattern; note `finance_reader_roles()` returns an empty array on purpose). Before switching any route to the admin client, check **who reaches it** — `/api/net-sales-summary` looks like finance but is called from the Taproom Achievement tab under `CAP.targetsRead`.
- **New `chart_of_accounts` FKs need a `coa_reference_count` arm.** All three tables in Task 1 carry one. Without an arm, deleting a referenced account reports zero references and then raises a raw 23503 instead of the designed 409. Add the arms in this PR's migration — but note the function is currently mid-repair in prod (see `20260905090000_fix_coa_reference_count.sql`), so restate the body from THAT file, not from `20260802_coa_reference_count.sql`, which references dropped columns and will abort at CREATE time.
- **Supabase client per context:** `server.ts` in route handlers, `browser.ts` in client components, `admin.ts` for cron and privileged writes.
- **Migrations:** this PR owns the full stamp `20260904130000` exclusively. Plain `YYYYMMDD` prefixes keep colliding with parallel branches, so new migrations take a full `YYYYMMDDHHMMSS` stamp. Never hand-edit an existing migration. **Subagents never apply migrations** — authoring is in scope, applying is orchestrator-only after user approval and a backup.
- **Graceful degradation is a requirement, not a nicety.** `taxAccrual` depends on `square_tax_accounts` (migration 20260827) and `tipAccrual` on `payroll_gl_settings.tips_chart_of_accounts_id` (20260823). Both may be unapplied in prod. Their existing try/catch-to-empty behavior must survive the move verbatim — a missing table must leave the balance sheet rendering, never 500 it.

## Task Table

| # | Task | Files | Model | Locality group |
|---|---|---|---|---|
| 1 | Migration + provider registry | 3 | Sonnet | registry |
| 2 | The six providers | 7 | Sonnet | providers |
| 3 | Snapshot + close tasks + alert email | 5 | Sonnet | services |
| 4 | Read path, presentation flip, variance row | 8 | Sonnet | financials |
| 5 | Routes + cron | 5 | Sonnet | routes |
| 6 | Settings rules screen | 3 | Sonnet | settings |

No task is escalated to Opus: this migration is additive DDL plus seed inserts with no destructive data operation, and no task touches `volumeLedger.ts` or `commitments.ts`. Escalate a task to Opus only if it fails Sonnet review twice.

---

### Task 1: Migration + provider registry

**Files:**
- Create: `supabase/migrations/20260904130000_balance_sheet_snapshots.sql`
- Create: `lib/finance/balances/registry.ts`
- Create: `lib/finance/balances/registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces — Tasks 2, 3, 5 and 6 all depend on these exact names:

```ts
export type ProviderKind = "derived" | "integration" | "manual";

export interface BalanceContext {
  supabase: AdminClient;          // ReturnType<typeof createSupabaseAdminClient>
  periodEnd: string;              // "YYYY-MM-DD", always a month end
  coaId: string;
  config: Record<string, unknown>;
}

export interface BalanceProvider {
  key: string;
  label: string;
  kind: ProviderKind;
  /** Filters which accounts this provider is offerable for in the Settings dropdown. */
  appliesTo?: (coa: CoaAccountRef) => boolean;
  /** Internal-convention cents (§2.2), or null when the balance cannot be determined. */
  compute(ctx: BalanceContext): Promise<number | null>;
}

export function registerProvider(p: BalanceProvider): void;
export function getProvider(key: string): BalanceProvider | undefined;
export function listProviders(): BalanceProvider[];
```

`CoaAccountRef` already exists in `lib/finance/financials/types.ts` — import it, do not redefine it.

**Schema produced** (Tasks 3, 5 and 6 read these column names):

- `balance_sheet_account_sources` — `chart_of_accounts_id`, `provider_key`, `config`, `active`, `updated_at`, `updated_by`. **Primary key `(chart_of_accounts_id, provider_key)`.**
- `gl_account_balances` — `id`, `chart_of_accounts_id`, `period_end`, `balance_cents`, `contributions` (jsonb), `is_frozen`, `computed_at`. Unique `(chart_of_accounts_id, period_end)`.
- `balance_close_tasks` — `id`, `chart_of_accounts_id`, `period_end`, `due_date`, `status`, `alert_sent_at`, `completed_at`, `notes`, `created_at`. Unique `(chart_of_accounts_id, period_end)`.

- [ ] **Step 1: Write the failing registry tests**

Create `lib/finance/balances/registry.test.ts` covering: registering then retrieving a provider by key; `getProvider` returns `undefined` for an unknown key; registering a duplicate key **throws** (a silent overwrite would make provider behavior depend on import order); `listProviders` returns every registered provider; `appliesTo` filtering selects the expected subset when given a mixed set of `CoaAccountRef`s.

The registry is module-level mutable state — reset it between tests via a `beforeEach`, and export a test-only `__resetRegistry()` for that purpose.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/finance/balances/registry.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

`lib/finance/balances/registry.ts` per the Interfaces block. A `Map<string, BalanceProvider>` at module scope. `registerProvider` throws on a duplicate key.

This mirrors `lib/tax/registry.ts` — read that file first and follow its shape rather than inventing a parallel style.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run lib/finance/balances/registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Author the migration**

Create `supabase/migrations/20260904130000_balance_sheet_snapshots.sql`:

1. The three tables above. `balance_cents bigint not null`. `contributions jsonb not null default '{}'`. `status text not null default 'open' check (status in ('open','completed','skipped'))`.

2. RLS on all three, via the applicator from `20260822`:

```sql
select public.apply_grant_policies('balance_sheet_account_sources', 'finance.transactions');
select public.apply_grant_policies('gl_account_balances',           'finance.statements');
select public.apply_grant_policies('balance_close_tasks',           'finance.statements');
```

3. The close-config row:

```sql
insert into system_settings (key, value)
values ('balance_sheet_close', '{"due_day": 5, "alert_lead_days": 0}'::jsonb)
on conflict (key) do nothing;
```

4. **Seed rows — mandatory, not optional.** Without these, every account that produces a number today silently goes blank on deploy. Insert into `balance_sheet_account_sources`, resolving each account by `account_number` subquery:

| `account_number` | `provider_key`(s) |
|---|---|
| `2220` | `taxAccrual`, `transactionPostings` |
| `2250` | `taxAccrual`, `transactionPostings` |
| `2230` | `transactionPostings` |
| `2420` | `transactionPostings` |
| `2430` | `transactionPostings` |
| `1100` | `openInvoiceAr` |
| `2310` | `tipAccrual` |
| `3300` | `retainedEarnings` |

2210, 2240 and 2260 are **deliberately not seeded** — no `square_tax_accounts` row points at them and they carry no postings. Seeding them would manufacture a source that computes to nothing and hide them from the unsourced-accounts tile.

Note `4999` is a duplicate `account_number` in this chart of accounts, so resolve-by-number is only safe for the numbers listed above. Use `select id from chart_of_accounts where account_number = 'NNNN'` and let it fail loudly if it returns more than one row.

- [ ] **Step 6: Verify prefix uniqueness, verify, commit**

```bash
node scripts/check-migrations.mjs --strict && npm run verify
```

```bash
git add supabase/migrations/20260904130000_balance_sheet_snapshots.sql lib/finance/balances/registry.ts lib/finance/balances/registry.test.ts
git commit -m "feat(finance): balance snapshot schema and provider registry"
```

**Acceptance criteria:**
- Registry tests pass, duplicate registration throws.
- `check-migrations.mjs --strict` clean.
- Seed table matches the eight accounts above exactly — no more, no fewer.
- Migration authored, **not applied**.

---

### Task 2: The six providers

**Files:**
- Create: `lib/finance/balances/providers/index.ts`
- Create: `lib/finance/balances/providers/transactionPostings.ts`
- Create: `lib/finance/balances/providers/accruals.ts`
- Create: `lib/finance/balances/providers/retainedEarnings.ts`
- Create: `lib/finance/balances/providers/manualBalance.ts`
- Create: `lib/finance/balances/providers/accruals.test.ts`
- Create: `lib/finance/balances/providers/retainedEarnings.test.ts`

**Interfaces:**
- Consumes: `BalanceProvider`, `registerProvider`, `BalanceContext` from Task 1.
- Produces: six registered provider keys — `transactionPostings`, `openInvoiceAr`, `tipAccrual`, `taxAccrual`, `retainedEarnings`, `manualBalance`. `providers/index.ts` imports all four provider modules for their registration side effect and exports nothing; consumers write `import "@/lib/finance/balances/providers"`. This mirrors `lib/tax/parties` — read it first.

**Provider map:**

| Key | Kind | Accounts | Origin |
|---|---|---|---|
| `transactionPostings` | derived | any BS account | today's direct-`chart_of_accounts_id` aggregation, wrapped |
| `openInvoiceAr` | derived | 1100 | **moved** from `buildFinancials.ts`'s `injectOpenInvoiceAr` |
| `tipAccrual` | derived | 2310 | **moved** from `fetchSources.ts`'s `fetchTipAccruals` |
| `taxAccrual` | derived | 2220, 2250 | **moved** from `fetchSources.ts`'s `fetchTaxAccruals` |
| `retainedEarnings` | derived | 3300 | new |
| `manualBalance` | manual | any BS account | new; reads `manual_entries` |

The three moved providers live together in `accruals.ts` because they are siblings in `fetchSources.ts` today and share its fetch idioms.

- [ ] **Step 1: Write the failing provider tests**

`accruals.test.ts` — for each of the three moved providers, assert the pure math against fixtures lifted from the **existing** `fetchSources.test.ts` cases so the move is provably behavior-preserving:
- `openInvoiceAr`: sums `total_cents` of open invoices dated on or before `periodEnd`; returns null (not 0) when there are none.
- `tipAccrual`: sums `tip_cents` for `status='COMPLETED'` orders with `invoice_id IS NULL` through `periodEnd`; returns null when the configured tips account is absent; returns null when the sum is `<= 0`. **The `COMPLETED` filter is load-bearing** — `syncPosTransactions.ts` keeps a canceled order's header `tip_cents` intact and only withdraws its line items, so dropping the filter silently inflates the liability.
- `taxAccrual`: unions POS and invoice line-item taxes, groups by mapped account, returns null when `square_tax_accounts` is empty. Assert that a *missing table* (simulated error) yields null rather than throwing.

`retainedEarnings.test.ts` — cumulative net income through `periodEnd`; a period with no P&L activity returns 0, not null (the account exists and is genuinely zero).

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/finance/balances/providers/
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the moved providers**

In `accruals.ts`, port `fetchTipAccruals`, `fetchTaxAccruals` and `injectOpenInvoiceAr`'s derivation **verbatim**, changing only their parameterization: each takes `periodEnd` instead of collapsing onto a single canonical month, and each returns a single `number | null` instead of a record array.

Preserve every existing guard exactly: the `COMPLETED` filters, the `<= 0` bail-out in the tip accrual, and both try/catch-to-empty degradations for unapplied migrations. These are not incidental — each has a comment in the current source explaining the bug it prevents. Read those comments before porting.

Sign: these providers feed liability accounts, so they must return **negative** cents in the internal convention (§2.2). Today that sign is applied downstream by `normalizeSignedCents`; here it must be applied inside the provider, because the snapshot layer does no further sign work. This is the single easiest thing to get wrong in this task.

- [ ] **Step 4: Implement the remaining three providers**

`transactionPostings.ts` — sums sign-normalized amounts from `pos_line_items`, `invoice_line_items`, `expenses` and `ramp_bank_ledger` tagged to `coaId` with a date on or before `periodEnd`. Reuse `normalizeSignedCents` for the sign so this provider cannot drift from the aggregation path it replaces. Returns null when no rows match.

`retainedEarnings.ts` — cumulative P&L net income through `periodEnd`, computed by reusing `aggregateRows` over cumulative sources so it cannot drift from the P&L. Deliberately one number for 3300 only; no current-year-earnings split (the chart of accounts has no such account).

`manualBalance.ts` — reads `manual_entries` where `entry_kind = 'balance'`, `chart_of_accounts_id = coaId`, `as_of_date = periodEnd`. Returns its `amount_cents`, or null when absent. `kind: "manual"`. This is what makes the close workflow work: null here is what Task 3 turns into an open task.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run lib/finance/balances/
```

Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
```

```bash
git add lib/finance/balances/providers/
git commit -m "feat(finance): balance providers"
```

**Acceptance criteria:**
- All six providers registered via the barrel import.
- Moved providers reproduce their source fixtures' values.
- Liability-feeding providers return negative cents.
- A simulated missing `square_tax_accounts` / `payroll_gl_settings` column yields null, never a throw.

---

### Task 3: Snapshot + close tasks + alert email

**Files:**
- Create: `lib/finance/balances/snapshot.ts`
- Create: `lib/finance/balances/snapshot.test.ts`
- Create: `lib/finance/balances/closeTasks.ts`
- Create: `lib/finance/balances/closeTasks.test.ts`
- Create: `lib/finance/balances/alertEmail.ts`

**Interfaces:**
- Consumes: the registry and providers from Tasks 1-2, and the three tables from Task 1.
- Produces — Tasks 4 and 5 depend on these:

```ts
// snapshot.ts
export interface SnapshotResult { written: number; skipped: number; errors: string[] }
export async function snapshotPeriod(supabase: AdminClient, periodEnd: string): Promise<SnapshotResult>;
/** coaId -> { "YYYY-MM": cents }. Reads gl_account_balances for the given months. */
export async function fetchBalances(supabase: SupabaseClient, months: string[]): Promise<Map<string, Record<string, number>>>;
export async function freezePeriod(supabase: AdminClient, periodEnd: string): Promise<void>;

/** Pure. Results keyed `${coaId}:${providerKey}` — an account may have several sources. */
export function resolveSnapshotWrites(
  sources: { coaId: string; providerKey: string }[],
  results: Map<string, number | null>,
  existing: Map<string, { isFrozen: boolean }>,
): { coaId: string; balanceCents: number; contributions: Record<string, number> }[];

// closeTasks.ts
export interface CloseTask { id: string; coaId: string; periodEnd: string; dueDate: string; status: "open" | "completed" | "skipped"; alertSentAt: string | null }
export async function ensureTasksForPeriod(supabase: AdminClient, periodEnd: string): Promise<number>;
export function tasksNeedingAlert(tasks: CloseTask[], today: string, leadDays: number): CloseTask[];  // pure
export async function markAlerted(supabase: AdminClient, ids: string[]): Promise<void>;
export async function reconcileCloseTasks(supabase: AdminClient, periodEnd: string): Promise<number>;
export function isPeriodClosed(tasks: CloseTask[]): boolean;  // pure

// alertEmail.ts
export function renderBalanceCloseEmail(tasks: { accountName: string; accountNumber: string | null; dueDate: string }[], periodEnd: string): { subject: string; html: string };
```

- [ ] **Step 1: Write the failing tests**

`snapshot.test.ts` — `resolveSnapshotWrites` only:
- A frozen existing row is skipped entirely.
- An account with **two** providers sums both results and records both under `contributions` keyed by provider key.
- One provider returning null still writes the other provider's value, with only the non-null contribution recorded.
- **All** providers null writes **no row at all** — the account must read as unsourced, not as a spurious $0. This is the case most likely to be implemented wrong.
- An existing non-frozen row is updated in place (deliberately unlike `autoMap.ts`'s fill-nulls-only convention — a derived balance must stay recomputable while the month is open).
- A source naming an unregistered provider key is skipped and reported, not thrown.

`closeTasks.test.ts`:
- `ensureTasksForPeriod` is idempotent across two runs (upsert on `(chart_of_accounts_id, period_end)` with `ignoreDuplicates`).
- `tasksNeedingAlert` boundaries: the day before, the day of, and the day after `dueDate - leadDays`; an already-alerted task is never returned twice; a completed task is never returned.
- `isPeriodClosed` — true when every task is `completed` or `skipped`, false with any `open`, true for an empty list.
- `reconcileCloseTasks` closes only tasks whose corresponding `manual_entries` balance row now exists.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/finance/balances/snapshot.test.ts lib/finance/balances/closeTasks.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `snapshot.ts`**

`snapshotPeriod` reads active sources, resolves each provider from the registry, runs them, and applies `resolveSnapshotWrites`'s decisions. Keep the decision logic entirely inside the pure function — the IO wrapper does fetch, call, write, and nothing else.

`fetchBalances` maps `period_end` to its `"YYYY-MM"` key for `amountCentsByMonth` consumption in Task 4.

`freezePeriod` sets `is_frozen = true` for every row of a period.

- [ ] **Step 4: Implement `closeTasks.ts` and `alertEmail.ts`**

`closeTasks.ts` mirrors `lib/tax/tasks.ts` almost function-for-function — read that
file first and follow its structure, its upsert idiom and its pure/IO split rather
than inventing a parallel style.

`ensureTasksForPeriod` creates one task per **active `manualBalance`-sourced** account that has no `manual_entries` balance row for that `period_end`. `due_date` comes from `system_settings.balance_sheet_close.due_day` applied to the month *after* `period_end`.

**Tasks are never completed by hand.** They close when the balance entry appears — that is `reconcileCloseTasks`'s entire job. Do not add a "complete task" write path; Task 5 wires the manual-entries route to call the reconciler instead.

`alertEmail.ts` mirrors `lib/tax/alertEmail.ts` — read it and match its structure and tone. The email lists each missing account and deep-links to `/finance/transactions/manual-entries`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run lib/finance/balances/
```

Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
```

```bash
git add lib/finance/balances/
git commit -m "feat(finance): balance snapshot service and month-end close tasks"
```

**Acceptance criteria:**
- All-null providers produce no snapshot row.
- Two providers on one account sum with both contributions recorded.
- Frozen rows are never rewritten.
- No hand-completion path exists for close tasks.

---

### Task 4: Read path, presentation flip, variance row

**Files:**
- Modify: `lib/finance/financials/buildFinancials.ts`
- Modify: `lib/finance/financials/fetchSources.ts`
- Modify: `app/finance/financials/buildTree.ts`
- Modify: `app/finance/financials/buildTree.test.ts`
- Modify: `lib/finance/financials/summaries.ts`
- Modify: `lib/finance/financials/summaries.test.ts`
- Modify: `app/finance/financials/DataQualityPanel.tsx`
- Modify: `app/finance/financials/page.tsx`

**Interfaces:**
- Consumes: `fetchBalances` from Task 3.
- Produces: `DataQualitySummary` gains `unsourcedAccounts: { count: number; href: string }`.

This is the task where month-over-month actually appears, and the one with the most subtle risk. Read spec §4.5 in full before starting.

- [ ] **Step 1: Write the failing tests**

`buildTree.test.ts`:
- The presentation flip negates **exactly** the five credit-side sections (`ap`, `credit_card`, `other_current_liabilities`, `long_term_liabilities`, `equity`) and leaves every asset section untouched.
- No P&L tree is affected by the flip.
- Balancing Difference arithmetic, including when a whole section is absent.
- **Existing balance-sheet assertions in this file carry the old signs and must be updated.** That update is the visible proof the flip landed — it is not incidental churn. Do not update a P&L assertion; if one needs changing, the flip has leaked.

`summaries.test.ts`: `unsourcedAccounts` counts balance-sheet accounts with no active source and excludes P&L accounts.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run app/finance/financials/buildTree.test.ts lib/finance/financials/summaries.test.ts
```

Expected: FAIL on the new assertions.

- [ ] **Step 3: Switch the balance-sheet read path to snapshots**

In `buildFinancials.ts`, the `balance_sheet` branch reads `fetchBalances()` for the trailing 12 months of `year` and emits one `FinancialsRow` per account with a populated `amountCentsByMonth`. The current open month computes live from providers so the statement is not stale mid-month; closed months read their frozen snapshot.

Delete `injectOpenInvoiceAr` — it is now the `openInvoiceAr` provider.

In `fetchSources.ts`, delete the balance-sheet branch, `cumulativeRange`, `collapseDates`, and the three accrual fetchers moved in Task 2. These are all balance-sheet-only; nothing in the P&L or cash-flow path references them. Confirm with a grep before deleting.

- [ ] **Step 4: Add the presentation flip and variance row**

In `buildTree.ts`'s `buildBalanceSheet`, add a display helper:

```ts
/** Balance-sheet presentation only: negate the credit-side sections so
 *  liabilities and equity render positive, per standard presentation.
 *  Applied at the tree layer AFTER every sum, so stored snapshots and
 *  normalizeSign.ts keep the internal convention (spec §2.2) and the P&L
 *  is untouched. */
function toPresentationSign(node: TreeNode, section: string): TreeNode;
```

Then add the **Balancing Difference** row after Total Liabilities + Equity. Compute it **once, post-flip**, as `totalAssets − totalLiabEquity`. Do not also implement the pre-flip `totalAssets + totalLiabEquity` form — they are the same number and two formulas invite drift.

`normalizeSign.ts` is **not** modified in this task or any other.

- [ ] **Step 5: Add the unsourced-accounts tile**

`summaries.ts`'s `buildDataQuality` gains `unsourcedAccounts`, counting balance-sheet accounts with no active `balance_sheet_account_sources` row, with an href to `/settings/finance/balance-sheet-accounts`. Render it in `DataQualityPanel.tsx` alongside the existing tiles.

In `page.tsx`, add a `<Banner>` shown when the latest month has open close tasks, deep-linking to `/finance/transactions/manual-entries`.

- [ ] **Step 6: Run the equivalence gate**

Before running, capture today's rendered balance-sheet Total-column values for GL 1100, 2220, 2230, 2250, 2310, 2420 and 2430 from the **live** app and commit them as a fixture. Per `feedback_frozen_tests_as_equivalence_gate`, a fixture that does not match production can hide the bug entirely — these must be real queried values, not invented ones.

Assert the provider path reproduces them for that month, **with the flip applied**: presentation changes sign but must never change magnitude.

```bash
npx vitest run lib/finance/financials/ app/finance/financials/
```

Expected: PASS, including the equivalence fixture.

- [ ] **Step 7: Verify and commit**

```bash
npm run verify
```

```bash
git add lib/finance/financials/ app/finance/financials/
git commit -m "feat(finance): month-over-month balance sheet with conventional signs"
```

**Acceptance criteria:**
- The balance sheet renders 12 month columns.
- Liabilities and equity render positive; assets unchanged.
- The P&L is byte-identical to before — no P&L test assertion changed.
- The equivalence fixture reproduces real production magnitudes.
- `cumulativeRange` and `collapseDates` no longer exist anywhere.

---

### Task 5: Routes + cron

**Files:**
- Create: `app/api/finance/balance-sources/route.ts`
- Create: `app/api/finance/balance-close/route.ts`
- Create: `app/api/cron/balance-close/route.ts`
- Modify: `app/api/finance/manual-entries/route.ts`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `snapshotPeriod`, `freezePeriod`, `ensureTasksForPeriod`, `tasksNeedingAlert`, `markAlerted`, `reconcileCloseTasks`, `isPeriodClosed`, `renderBalanceCloseEmail` from Task 3.
- Produces:
  - `GET /api/finance/balance-sources` → every balance-sheet account with its sources and available providers.
  - `PUT /api/finance/balance-sources` body `{ coaId, providerKey, config?, active? }` → upsert one source.
  - `DELETE /api/finance/balance-sources` body `{ coaId, providerKey }` → remove one source.
  - `GET /api/finance/balance-close?periodEnd=YYYY-MM-DD` → the period's tasks and closed state.

There is **no new read route for balances** — the balance sheet keeps using `/api/finance/financials`.

- [ ] **Step 1: Implement the two API routes**

`balance-sources`: `GET` gated on `CAP.financeStatementsRead`; `PUT`/`DELETE` on `CAP.financeTransactionsManage`. Because the table's PK is `(chart_of_accounts_id, provider_key)`, `PUT` upserts a **single** source and `DELETE` removes a single source — neither replaces an account's whole source list. Reject a `providerKey` that is not in `listProviders()` with a 400.

`balance-close`: `GET` gated on `CAP.financeStatementsRead`.

Both use `createSupabaseServerClient()` and wrap errors with `apiError()`.

- [ ] **Step 2: Wire the manual-entries reconciler hook**

In `app/api/finance/manual-entries/route.ts` (created in PR A), call `reconcileCloseTasks(supabase, asOfDate)` after a successful `entry_kind === "balance"` insert or update, so the close task clears immediately rather than waiting for the next cron run.

Failure of the reconciler must **not** fail the entry write — the entry is the user's data and the task is derived bookkeeping. Log and continue.

- [ ] **Step 3: Implement the cron**

`app/api/cron/balance-close/route.ts`, wrapped in `runCronJob("balance-close", ...)` so it lands in `cron_runs` for the Settings > Cron Jobs monitor. `export const dynamic = "force-dynamic";`

For the most recently ended month, in order: `ensureTasksForPeriod` → `snapshotPeriod` → `reconcileCloseTasks` → alert via `renderBalanceCloseEmail` + `sendEmail`/`ADMIN_EMAIL` from `lib/resend` → `freezePeriod` once `isPeriodClosed` or past `due_date`.

Follow `app/api/cron/tax-tasks/route.ts` for the alert-then-`markAlerted` sequencing — read it first.

- [ ] **Step 4: Register the cron**

In `vercel.json`, append:

```json
{ "path": "/api/cron/balance-close", "schedule": "0 9 * * *" }
```

09:00 is deliberate — it runs after `finance-sync` at 07:30 so the snapshot sees a fully ingested month.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
```

```bash
git add app/api/finance/balance-sources app/api/finance/balance-close app/api/cron/balance-close app/api/finance/manual-entries/route.ts vercel.json
git commit -m "feat(finance): balance source routes and month-end close cron"
```

**Acceptance criteria:**
- An unknown provider key is rejected with 400.
- Entering a balance clears its close task without waiting for the cron.
- A reconciler failure never fails the entry write.
- The cron appears in `cron_runs` after a run.

---

### Task 6: Settings rules screen

**Files:**
- Create: `app/settings/finance/balance-sheet-accounts/page.tsx`
- Modify: `app/settings/nav-config.ts`
- Modify: `lib/query-keys.ts`

**Interfaces:**
- Consumes: the `balance-sources` route from Task 5.
- Produces: nothing.

- [ ] **Step 1: Add the nav entry and query keys**

In `app/settings/nav-config.ts`, add after the Sales Tax Accounts entry (line 75):

```ts
{ href: "/settings/finance/balance-sheet-accounts", label: "Balance Sheet Accounts" },
```

In `lib/query-keys.ts`, add to the `finance` block:

```ts
balanceSources: () => ["finance", "balance-sources"] as const,
balanceClose:   (periodEnd: string) => ["finance", "balance-close", periodEnd] as const,
```

- [ ] **Step 2: Build the page**

Use `app/settings/finance/sales-tax-accounts/page.tsx` as the template — read it first and follow its structure rather than inventing a new one.

One row per balance-sheet account showing: account name and number; its **list** of configured sources (an account may have several — the 2220 seed has two); an add-source control whose `<select>` is filtered by each provider's `appliesTo`; per-source config and active toggle; and a read-only "current balance / as of" column that breaks out `contributions` per provider so a balance is explainable at a glance.

**No editable dollar values on this screen.** A `manualBalance`-sourced row deep-links to `/finance/transactions/manual-entries` instead. Settings holds rules; Transactions holds values — this separation is the whole point of PR A and must not be quietly undone here.

Gated on `CAP.financeTransactionsManage`.

- [ ] **Step 3: Verify and grep for UI violations**

```bash
npm run verify
```

```bash
grep -nE "zinc-|amber-|red-|green-|blue-|gray-|#[0-9a-fA-F]{3,6}|inputCls" app/settings/finance/balance-sheet-accounts/page.tsx
```

Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add app/settings/finance/balance-sheet-accounts lib/query-keys.ts app/settings/nav-config.ts
git commit -m "feat(finance): Balance Sheet Accounts settings screen"
```

**Acceptance criteria:**
- An account can carry more than one source, added and removed independently.
- The provider dropdown respects `appliesTo`.
- No dollar input exists anywhere on the screen.
- The UI-standard grep is clean.

---

## Post-Implementation

**Orchestrator-only, after all six tasks are reviewed and merged:**

1. Apply `20260903` with explicit user approval. It is additive, but verify the eight seed rows landed and resolved to the right accounts.
2. Run `snapshotPeriod` for the most recent closed month and compare GL 1100, 2220, 2230, 2250, 2310, 2420 and 2430 against the pre-merge values captured for the Task 4 equivalence fixture. A magnitude difference means a provider port is wrong.
3. Confirm the Balancing Difference row is non-zero and roughly equals the sum of the unsourced accounts' true balances — a difference of *zero* at this stage would be suspicious, not reassuring, since most accounts still have no source.
4. Verify the first cron run appears in Settings > Cron Jobs and that an alert email arrives for the manual accounts.

**Deferred to follow-up PRs** (spec §5): inventory providers 1210/1220/1240, batch costing for 1230, Square Payouts for 1040/1400, Ramp balances for 1030/2110, gift cards 2410, payroll tax payable 2320, the fixed-asset register 1500–1590, and the current-year-earnings split.
