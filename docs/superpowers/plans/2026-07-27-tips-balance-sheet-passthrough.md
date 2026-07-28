# Tips as a Balance-Sheet Pass-Through — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route both legs of employee tips to a configurable balance-sheet liability account so tips never touch the P&L, and record that attribution explicitly.

**Execution Budget:** Mode = subagent-driven-development (6 locality groups, ~16 files). **Spawn cap = 8.** Token target ≈ 250k. STOP and report before exceeding the cap.

**Architecture:** Two independent read paths converge on one `Other Current Liabilities` account. The payout leg carves paycheck tips out of the Gusto CSV at their exact amount before the existing pro-rata fill runs; the collection leg derives a monthly accrual from `square_orders.tip_cents` on read, with no new table. Because the account's statement section is never summed by any P&L KPI, exclusion is structural rather than filter-based.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres (admin client), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-27-tips-balance-sheet-passthrough-design.md`

## Global Constraints

- All monetary values are **integer cents**. No floats, no dollar strings.
- Business logic lives in `lib/`, never in `app/api/**` or page components.
- New or modified `lib/` modules ship a co-located `*.test.ts`. Do not drop `lib/` coverage below the `vitest.config.ts` floor.
- `npm run verify` (lint + typecheck + tests) must pass before every commit.
- **Never apply a migration to prod.** Write the file only. The orchestrator applies it after explicit approval and a backup.
- Use the Supabase client matching the execution context — these paths are server/admin (`lib/supabase/admin.ts`).
- UI work: token utilities only (no `zinc-*`/`amber-*`/hex literals), existing `app/components/ui/` primitives only (`Card`, `Banner`, `AccountSelect`, `.btn-primary`).
- Migration prefixes must be verified against `schema_migrations` before any push — the CLI keys on digits before the first `_`, and same-day prefixes have collided in this repo.
- This Next.js version differs from training data — consult `docs/nextjs16-deltas.md` before touching routing conventions.

---

## Task Table

| # | Task | Group | Files | Model |
|---|---|---|---|---|
| 1 | Migrations: tips account + bucket_kind | G1 | 2 | Haiku |
| 2 | Parser captures paycheck tips | G2 | 2 | Sonnet |
| 3 | Upload wires the tips account | G2 | 2 | Sonnet |
| 4 | Two-stage exact tip carve-out | G3 | 2 | **Opus** |
| 5 | normalizeSign liability fix | G4 | 2 | Sonnet |
| 6 | Tip accrual source | G4 | 4 | Sonnet |
| 7 | Settings UI + route | G5 | 3 | Sonnet |
| 8 | Backfill with dry-run | G6 | 3 | Sonnet |

Task 4 is Opus per the escalation rule for novel algorithmic logic — the two-stage largest-remainder allocation must satisfy three simultaneous invariants.

**Ordering constraint:** Task 5 must land before Task 8. Backfilling with the current sign logic writes history inverted.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260823_payroll_tips_account.sql` | Adds + seeds `payroll_gl_settings.tips_chart_of_accounts_id` |
| `supabase/migrations/20260824_payroll_gl_bucket_kind.sql` | Adds `payroll_gl_report_totals.bucket_kind` |
| `lib/payroll/gustoParser.ts` | Captures Paycheck Tips; emits a kinded tips bucket |
| `lib/payroll/gustoUpload.ts` | Reads the tips account setting; persists `bucket_kind` |
| `lib/finance/payrollMatching.ts` | Exact tip carve-out before pro-rata fill |
| `lib/finance/financials/normalizeSign.ts` | Correct sign for expense/bank on BS liability sections |
| `lib/finance/financials/fetchSources.ts` | `fetchTipAccruals` — derived collection leg |
| `lib/finance/financials/aggregateRows.ts` | `tip_accrual` source type + resolve branch |
| `lib/finance/financials/buildFinancials.ts` | Passes accruals through to aggregation |
| `lib/payroll/glBackfill.ts` | Re-parse stored CSVs, rewrite totals, recompute splits |
| `app/api/payroll/gl-reports/backfill/route.ts` | Thin handler over `glBackfill.ts` |
| `app/api/finance/settings/payroll-department-mappings/route.ts` | Reads/writes the tips account setting |
| `app/finance/settings/payroll-department-mappings/page.tsx` | Tips account picker |

---

### Task 1: Migrations — tips account + bucket_kind

**Files:**
- Create: `supabase/migrations/20260823_payroll_tips_account.sql`
- Create: `supabase/migrations/20260824_payroll_gl_bucket_kind.sql`

**Interfaces:**
- Produces: `payroll_gl_settings.tips_chart_of_accounts_id` (uuid, nullable, FK → `chart_of_accounts.id`); `payroll_gl_report_totals.bucket_kind` (text, NOT NULL, default `'wages'`, CHECK in `'wages' | 'employer_tax' | 'tips'`)

Two files with **distinct** numeric prefixes — two files sharing `20260823_` would collide as one version. `20260821` is the latest on disk; `20260822` is claimed by the unmerged grant-aware-RLS branch.

- [ ] **Step 1: Write `20260823_payroll_tips_account.sql`**

```sql
ALTER TABLE payroll_gl_settings
  ADD COLUMN tips_chart_of_accounts_id uuid REFERENCES chart_of_accounts(id);

UPDATE payroll_gl_settings
   SET tips_chart_of_accounts_id = (
     SELECT id FROM chart_of_accounts
      WHERE account_name = 'Payroll Liabilities:Undistributed Tips'
      LIMIT 1
   )
 WHERE tips_chart_of_accounts_id IS NULL;
```

- [ ] **Step 2: Write `20260824_payroll_gl_bucket_kind.sql`**

```sql
ALTER TABLE payroll_gl_report_totals
  ADD COLUMN bucket_kind text NOT NULL DEFAULT 'wages'
    CHECK (bucket_kind IN ('wages', 'employer_tax', 'tips'));
```

- [ ] **Step 3: Verify the seed target exists**

Confirm exactly one `chart_of_accounts` row is named `Payroll Liabilities:Undistributed Tips`. If zero or more than one, STOP and report — the seed subquery would silently leave the column null or pick arbitrarily.

- [ ] **Step 4: Do NOT apply to prod**

Write the files only. Existing `payroll_gl_report_totals` rows will read `'wages'`, including the employer-tax bucket. That is a **safe intermediate state**: with no row marked `'tips'`, the Task 4 split math finds no tips bucket and behaves exactly as it does today. Task 8's backfill corrects the kinds.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260823_payroll_tips_account.sql supabase/migrations/20260824_payroll_gl_bucket_kind.sql
git commit -m "feat(payroll): add tips GL account setting and bucket_kind"
```

**Acceptance:** Both files exist with distinct prefixes; neither is applied to prod.

---

### Task 2: Parser captures paycheck tips

**Files:**
- Modify: `lib/payroll/gustoParser.ts`
- Test: `lib/payroll/gustoParser.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks
- Produces:
  ```ts
  export type GlBucketKind = "wages" | "employer_tax" | "tips";

  export interface ParsedGustoEmployee {
    // ...existing fields unchanged...
    paycheckTipsCents: number; // 0 when the employee has no Paycheck Tips sub-row
  }

  export interface GlBucketTotal {
    chartOfAccountsId: string;
    amountCents: number;
    kind: GlBucketKind;
  }

  export function computeGlBucketTotals(
    parsed: ParsedGustoReport,
    departmentMap: Map<string, string>,
    payrollTaxesAccountId: string,
    tipsAccountId: string,
  ): GlBucketTotal[];
  ```

**Behavior:**
- The blank-Last-Name sub-row loop (currently `gustoParser.ts:160-164`) adds `parseAmountCents(cell(row, COL.amount))` to `current.paycheckTipsCents` when `label === "Paycheck Tips"`.
- `"Cash Tips"` stays discarded — no company money moves. `"Bonus"` and `"Gross"` handling is unchanged.
- `paycheckTipsCents` must NOT be added to `grossAmountCents`.
- The tips bucket sums `paycheckTipsCents` across **all** employees regardless of department mapping — it is one company-wide liability bucket, exactly like employer taxes.
- Emit the tips bucket **only when the sum is > 0**. Never emit a $0 row.
- Existing wage buckets get `kind: "wages"`; the employer-tax bucket gets `kind: "employer_tax"`.

- [ ] **Step 1: Write failing tests**

Cover, using the existing test file's CSV-fixture style:
1. A `Paycheck Tips` sub-row sets `paycheckTipsCents` and leaves `grossAmountCents` unchanged.
2. A `Cash Tips` sub-row is ignored — `paycheckTipsCents` stays 0.
3. `computeGlBucketTotals` emits one `kind: "tips"` bucket whose `amountCents` equals the exact sum across all employees.
4. A report with no tip rows emits **no** tips bucket.
5. An employee in an unmapped department still contributes their tips to the tips bucket (mirrors employer-tax behavior).
6. Existing wage/tax buckets carry the correct `kind`.

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run lib/payroll/gustoParser.test.ts`
Expected: FAIL — `paycheckTipsCents` undefined, `computeGlBucketTotals` arity mismatch.

- [ ] **Step 3: Implement**

Update the interfaces, the sub-row branch, and `computeGlBucketTotals`. Keep the existing doc comment accurate — it currently claims tips are excluded; it must now say Cash Tips are excluded and Paycheck Tips route to the tips account.

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run lib/payroll/gustoParser.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add lib/payroll/gustoParser.ts lib/payroll/gustoParser.test.ts
git commit -m "feat(payroll): capture paycheck tips as a kinded GL bucket"
```

**Acceptance:** Tips are a separate kinded bucket; gross wages are unchanged; zero-tip reports emit no tips bucket.

---

### Task 3: Upload wires the tips account

**Files:**
- Modify: `lib/payroll/gustoUpload.ts`
- Test: `lib/payroll/gustoUpload.test.ts`

**Interfaces:**
- Consumes: `computeGlBucketTotals(parsed, departmentMap, payrollTaxesAccountId, tipsAccountId)` and `GlBucketTotal.kind` from Task 2
- Produces: `payroll_gl_report_totals` rows carrying `bucket_kind`

**Behavior:**
- The settings select at `gustoUpload.ts:83` also reads `tips_chart_of_accounts_id`.
- If it is null, throw before any DB write: `"No tips account configured — set one in Finance → Settings → Payroll Departments before uploading a Gusto report."` This mirrors the route's existing treatment of `payrollTaxesAccountId`.
- The totals insert at `gustoUpload.ts:146` adds `bucket_kind: bucket.kind`.
- All existing upload/rollback ordering guarantees are unchanged.

- [ ] **Step 1: Write failing tests**

1. A null `tips_chart_of_accounts_id` throws, and **no** `payroll_gl_reports` row is inserted.
2. Persisted totals carry `bucket_kind` matching each bucket's kind.
3. Existing supersede/rollback tests still pass unmodified.

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run lib/payroll/gustoUpload.test.ts`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run lib/payroll/gustoUpload.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add lib/payroll/gustoUpload.ts lib/payroll/gustoUpload.test.ts
git commit -m "feat(payroll): persist bucket_kind and require a tips account on upload"
```

**Acceptance:** Upload fails loudly without a tips account; `bucket_kind` round-trips.

---

### Task 4: Two-stage exact tip carve-out

**Files:**
- Modify: `lib/finance/payrollMatching.ts`
- Test: `lib/finance/payrollMatching.test.ts`

**Interfaces:**
- Consumes: `bucket_kind` from Task 1's migration
- Produces:
  ```ts
  export interface PeriodBucket {
    chartOfAccountsId: string;
    amountCents: number;
    kind?: "wages" | "employer_tax" | "tips"; // absent ⇒ treated as non-tips
  }

  export function computeProportionalSplits(
    matchedExpenses: MatchedExpenseAmount[],
    periodTotals: PeriodBucket[],
  ): Map<string, ProportionalLine[]>;
  ```
  `ProportionalLine` is unchanged. `recomputePeriodExpenseSplits` additionally selects `bucket_kind` from `payroll_gl_report_totals` and maps it onto `PeriodBucket.kind`.

**Algorithm** — this is the one place inline logic is warranted:

```
tipBuckets  = periodTotals.filter(b => b.kind === "tips")
restBuckets = periodTotals.filter(b => b.kind !== "tips")
matchedTotal = Σ matchedExpenses.amountCents

// Stage 1 — EXACT. Per tip bucket, distribute its full amount across expenses
// by each expense's share of matchedTotal: floor, then hand out the leftover
// cents largest-remainder-first. Σ over expenses === that bucket's amount.
// Clamp: if an expense's tip share would exceed its own amount, cap it at the
// expense amount and record an overflow flag.

// Stage 2 — FILL. For each expense, distribute (amount_i − its tip shares)
// across restBuckets using the EXISTING ratio + largest-remainder logic,
// unchanged.
```

Carving tips out **before** the fill is the whole point. Treating the tips bucket as just another entry in `periodTotals` would scale it too — Jun 1–14 would post `$911.58 × (7943.72 / 7121.29) = $1,017`, over-crediting the liability by the residual's share.

**Three simultaneous invariants:**
1. Each expense's lines sum exactly to its own `amountCents` *(preserved from today)*
2. The residual is still absorbed by wage/tax buckets *(preserved — decision: force-fill retained)*
3. Tip lines across all of a period's expenses sum exactly to the period tip total *(new)*

Guards: `matchedTotal === 0` returns no lines (mirrors the existing `periodTotal > 0` guard). `tipsTotal > matchedTotal` clamps per expense rather than emitting negative wage lines.

- [ ] **Step 1: Write failing tests**

**Golden case — real prod shape, pay period 2026-06-01 → 2026-06-14:**

```ts
const expenses = [
  { expenseId: "a", amountCents: 548554 },
  { expenseId: "b", amountCents: 166510 },
  { expenseId: "c", amountCents:  65592 },
  { expenseId: "d", amountCents:  13716 },
]; // Σ = 794372
const buckets = [
  { chartOfAccountsId: "labor", amountCents: 487539, kind: "wages" },
  { chartOfAccountsId: "taproom", amountCents:  62398, kind: "wages" },
  { chartOfAccountsId: "admin",   amountCents:   5824, kind: "wages" },
  { chartOfAccountsId: "taxes",   amountCents:  65210, kind: "employer_tax" },
  { chartOfAccountsId: "tips",    amountCents:  91158, kind: "tips" },
];
```

Assert:
1. Σ of all `tips` lines across the four expenses === **exactly 91158**
2. Each expense's lines sum to exactly its own `amountCents`
3. No line is negative
4. The `$822.43` residual still lands on wage/tax buckets, not on tips

Plus:
5. **Equivalence:** with no `tips` bucket present, output is byte-identical to the pre-change implementation (guards the safe intermediate state from Task 1)
6. Buckets with `kind` absent behave as non-tips
7. Single expense, tips-only bucket → the whole amount goes to tips
8. `tipsTotal > matchedTotal` → clamped, no negative lines
9. `matchedTotal === 0` → no lines

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run lib/finance/payrollMatching.test.ts`

- [ ] **Step 3: Implement the two-stage split**

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run lib/finance/payrollMatching.test.ts` → PASS. Confirm assertion 1 reports exactly `91158`, not `91157` or `91159` — an off-by-one here means the largest-remainder pass is wrong.

- [ ] **Step 5: Update `recomputePeriodExpenseSplits` to select and map `bucket_kind`**

- [ ] **Step 6: Run full verify**

Run: `npm run verify` → PASS

- [ ] **Step 7: Commit**

```bash
git add lib/finance/payrollMatching.ts lib/finance/payrollMatching.test.ts
git commit -m "feat(finance): carve tips out of payroll splits at their exact amount"
```

**Acceptance:** All three invariants hold on the golden case; zero-tips input is provably equivalent to today.

---

### Task 5: normalizeSign liability fix

**Files:**
- Modify: `lib/finance/financials/normalizeSign.ts`
- Test: `lib/finance/financials/normalizeSign.test.ts`
- Temporary: `lib/finance/financials/normalizeSign.frozen.test.ts` (created then deleted within this task)

**Interfaces:**
- Produces: `NormalizeSource` union gains `"tip_accrual"` (consumed by Task 6)

**Behavior:** For `source === "expense" | "bank"` on a **balance-sheet** section, replace the `magnitude` / `-magnitude` branches (`normalizeSign.ts:62-63`) with `return -rawCents;`. The P&L-section pass-through (the C1 fix, line 60), the refund rule, and the pos/invoice branch are all unchanged.

Add `"tip_accrual"` to the inline source union in `normalizeSignedCents`'s signature. It requires **no new branch** — it falls through to the pos/invoice logic, taking its sign from the section, which is what an unsigned-positive accrual needs.

**Note:** this union is declared in *two* places. This task updates only the inline one in `normalizeSign.ts`. The sibling `type NormalizeSource` in `aggregateRows.ts:132` is Task 6's responsibility — until Task 6 lands, the two are intentionally out of sync but still typecheck, because `aggregateRows.ts` never passes `"tip_accrual"` yet.

**Why this is safe:** it is equivalent to current behavior for every case with real data, and differs only where cash direction is reversed — which is the broken case.

| Case | raw | current | new |
|---|---|---|---|
| Asset purchase (outflow → asset up) | −X | +X | +X |
| Existing test `("ap", "bank", 20000)` | +20000 | −20000 | −20000 |
| **Liability paydown (outflow)** | −X | **−X** ✗ | **+X** ✓ |

Two live rows already hit the broken case: expenses mapped to `Sales & Excise Taxes Payable:North Carolina Department of Revenue Payable`.

- [ ] **Step 1: Freeze the existing test file as an equivalence gate**

```bash
cp lib/finance/financials/normalizeSign.test.ts lib/finance/financials/normalizeSign.frozen.test.ts
```

Do this **before** touching the source. This is a live computation path.

- [ ] **Step 2: Run the frozen suite against unmodified source**

Run: `npx vitest run lib/finance/financials/normalizeSign.frozen.test.ts`
Expected: PASS — establishes the baseline.

- [ ] **Step 3: Write new failing tests in the real test file**

1. `("other_current_liabilities", "expense", -190000)` → `190000` (paying tips down reduces the liability)
2. `("other_current_liabilities", "bank", 50000)` → `-50000` (an inflow increases it)
3. `("ap", "expense", -20000)` → `20000` (the NC DOR case)
4. `("other_current_liabilities", "tip_accrual", 204354)` → `-204354` (collected tips increase the liability)
5. Asset case unchanged: `("fixed_assets", "expense", -50000)` → `50000`

- [ ] **Step 4: Run, verify cases 1–4 fail**

Run: `npx vitest run lib/finance/financials/normalizeSign.test.ts`

- [ ] **Step 5: Implement**

- [ ] **Step 6: Run BOTH suites**

Run: `npx vitest run lib/finance/financials/normalizeSign.test.ts lib/finance/financials/normalizeSign.frozen.test.ts`
Expected: both PASS. **A frozen-suite failure means the change is not equivalence-preserving — STOP and report rather than editing the frozen file.**

- [ ] **Step 7: Delete the frozen file**

```bash
rm lib/finance/financials/normalizeSign.frozen.test.ts
```

- [ ] **Step 8: Run full verify, then commit**

```bash
npm run verify
git add lib/finance/financials/normalizeSign.ts lib/finance/financials/normalizeSign.test.ts
git commit -m "fix(finance): reduce a liability when an expense pays it down"
```

**Acceptance:** Frozen suite passes unmodified; liability rows sign correctly in both directions.

---

### Task 6: Tip accrual source

**Files:**
- Modify: `lib/finance/financials/fetchSources.ts`
- Modify: `lib/finance/financials/aggregateRows.ts`
- Modify: `lib/finance/financials/buildFinancials.ts`
- Test: `lib/finance/financials/fetchSources.test.ts`, `lib/finance/financials/aggregateRows.test.ts`

**Interfaces:**
- Consumes: `"tip_accrual"` in `normalizeSignedCents`'s source union (Task 5)
- Produces:
  ```ts
  // aggregateRows.ts — add "tip_accrual" to the local `type NormalizeSource`
  // (line ~132) so it matches the union Task 5 added in normalizeSign.ts.
  export interface TipAccrualRecord {
    id: string;              // synthetic, e.g. `tips-2026-06`
    chartOfAccountsId: string;
    amountCents: number;     // positive magnitude of tips collected
    monthKey: string;        // "YYYY-MM", already canonical
  }
  // AggregateRowsInput gains: tipAccruals: TipAccrualRecord[]

  // fetchSources.ts
  export async function fetchTipAccruals(
    supabase: SupabaseClient,
    range: DateRange,
    tipsAccountId: string | null,
  ): Promise<TipAccrualRecord[]>;
  // FinancialsSourcesResult gains: tipAccruals: TipAccrualRecord[]
  ```

**Behavior:**
- Sum `square_orders.tip_cents` where `invoice_id is null` (matching the taproom basis) across the range.
- Paginate through `fetchAllRows` — PostgREST silently truncates at 1000 rows.
- **Balance-sheet mode only.** Return `[]` for `pl` and `cash_flow`, exactly as `openInvoiceArCents` does. Because BS mode collapses everything onto one canonical month key, this returns **a single record** for that key summing the whole cumulative range — no per-month grouping is needed.
- Return `[]` when `tipsAccountId` is null; never fail the financials page over an unconfigured setting.
- `fetchFinancialsSources` reads `payroll_gl_settings.tips_chart_of_accounts_id` (BS mode only) and passes it in.
- `aggregateRows` gains a resolve branch: `monthKey` is used directly (no date parsing), `channel: "unknown"`, `bbl: 0`, `bblCoverage: "full"`, `mappingSource: "rule"`, `table: "square_orders"`, source `"tip_accrual"`.
- `buildFinancials` passes `tipAccruals: src.tipAccruals` into `aggregateRows`.

- [ ] **Step 1: Write failing tests**

`fetchTipAccruals`:
1. Sums `tip_cents` across orders in range into one canonical-month record
2. Excludes rows with a non-null `invoice_id`
3. Returns `[]` when `tipsAccountId` is null
4. Pages past 1000 rows (mock a 1000-row first page + short second page)

`aggregateRows`:
5. A tip accrual on an `other_current_liabilities` account resolves to **negative** signed cents
6. A tip accrual whose `monthKey` is outside `months` is dropped
7. Accrual and payout on the same account in the same month **offset** rather than compound — the sharpest regression risk in this task

`buildFinancials`:
8. `tipAccruals` is `[]` for `pl` and `cash_flow`

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run lib/finance/financials/`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run lib/finance/financials/` → PASS

- [ ] **Step 5: Run full verify, then commit**

```bash
npm run verify
git add lib/finance/financials/
git commit -m "feat(finance): accrue collected card tips to the tips liability"
```

**Acceptance:** Collection and payout legs carry opposite signs and offset; P&L payload is unchanged.

---

### Task 7: Settings UI + route

**Files:**
- Modify: `app/api/finance/settings/payroll-department-mappings/route.ts`
- Modify: `app/finance/settings/payroll-department-mappings/page.tsx`
- Test: `app/api/finance/settings/payroll-department-mappings/route.test.ts`

**Interfaces:**
- Consumes: `payroll_gl_settings.tips_chart_of_accounts_id` (Task 1)
- Produces: `GET` response gains `tipsAccountId: string | null`; `PUT` body requires `tipsAccountId: string`

**Behavior:**
- `GET` selects `tips_chart_of_accounts_id` alongside `payroll_taxes_chart_of_accounts_id`, returning it as `tipsAccountId`.
- `PUT` returns 400 `"tipsAccountId required"` when absent, mirroring the existing `payrollTaxesAccountId` guard, and includes it in the singleton upsert.
- The page adds a second `AccountSelect` beside the payroll-taxes picker, labelled so its purpose is unambiguous — e.g. **"Tips liability account"** with helper text: *"Paycheck tips from Gusto uploads post here instead of to wage accounts. Tips never appear on the P&L."*
- Restrict its options to liability accounts:
  ```ts
  const TIPS_ACCOUNT_TYPES = new Set(["Other Current Liabilities", "Long Term Liabilities"]);
  ```
  Filter `accounts` before passing to `AccountSelect` — do not add a filtering prop to the shared component.
- Existing `Card`/`Banner` layout and save flow are reused as-is. No new primitives, no raw colors.

**Conflict warning:** a concurrent session is consolidating settings tabs and may move this page under a combined "GL Mapping" tab. Coordinate or rebase — do **not** revert its changes.

- [ ] **Step 1: Write failing route tests**

1. `GET` returns `tipsAccountId` from the settings row
2. `GET` returns `null` when the column is null
3. `PUT` without `tipsAccountId` → 400
4. `PUT` persists it and echoes it back
5. Existing mapping replace-set behavior is unaffected

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run app/api/finance/settings/payroll-department-mappings/route.test.ts`

- [ ] **Step 3: Implement the route**

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Implement the page picker**

- [ ] **Step 6: Verify in the browser**

Start the dev server via the preview tooling (never `npm run dev` in Bash), load `/finance/settings/payroll-department-mappings`, confirm: the picker lists only liability accounts, saving persists across reload, and the console is clean. Screenshot for the review.

- [ ] **Step 7: Run full verify, then commit**

```bash
npm run verify
git add app/api/finance/settings/payroll-department-mappings/route.ts app/api/finance/settings/payroll-department-mappings/route.test.ts app/finance/settings/payroll-department-mappings/page.tsx
git commit -m "feat(finance): configure the tips liability account in settings"
```

**Acceptance:** The tips account is selectable, persists, and is required on save.

---

### Task 8: Backfill with dry-run

**Files:**
- Create: `lib/payroll/glBackfill.ts`
- Create: `lib/payroll/glBackfill.test.ts`
- Create: `app/api/payroll/gl-reports/backfill/route.ts`

**Interfaces:**
- Consumes: `parseGustoPayrollJournal` + `computeGlBucketTotals` (Task 2), `recomputePeriodExpenseSplits` (Task 4)
- Produces:
  ```ts
  export interface BackfillBucketSummary {
    wagesCents: number;
    employerTaxCents: number;
    tipsCents: number;
  }

  export interface BackfillPeriodResult {
    payPeriodId: string;
    reportId: string;
    before: BackfillBucketSummary;
    after: BackfillBucketSummary;
    splitsRecomputed: boolean;
    error?: string;
  }

  export async function backfillGlReports(
    sb: SupabaseClient,
    opts: { dryRun: boolean },
  ): Promise<BackfillPeriodResult[]>;
  ```

**Behavior:**
- For every non-superseded `payroll_gl_reports` row: download its CSV from the private `payroll-gl-reports` Storage bucket (service-role admin client — the anon client cannot read it), re-parse, and recompute buckets with the current department map + taxes account + tips account.
- `dryRun: true` computes and returns before/after **without any write**.
- `dryRun: false` replaces that report's `payroll_gl_report_totals` rows, then calls `recomputePeriodExpenseSplits`, which already skips expenses carrying a `split_source='manual'` override.
- A failure on one report records `error` and continues — one unreadable CSV must not abort the run.
- Route: `POST` with `{ dryRun?: boolean }`, defaulting to **`true`**. Guard with `requirePermission(CAP.payrollOperate)`; wrap errors with `apiError()`. Handler stays thin — all logic in `lib/`.

**This task writes the tool. It does NOT run it against prod.** The orchestrator runs it, after explicit approval and a backup.

- [ ] **Step 1: Write failing tests**

1. `dryRun: true` performs **zero** writes (assert no `insert`/`delete`/`update` on the mocked client) and returns populated before/after
2. `dryRun: false` replaces totals and calls `recomputePeriodExpenseSplits` once per period
3. Superseded reports are skipped
4. A report whose CSV download fails records `error` and does not halt the remaining periods
5. `before`/`after` summaries bucket by `kind` correctly

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run lib/payroll/glBackfill.test.ts`

- [ ] **Step 3: Implement `lib/payroll/glBackfill.ts`**

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Implement the route handler**

- [ ] **Step 6: Run full verify, then commit**

```bash
npm run verify
git add lib/payroll/glBackfill.ts lib/payroll/glBackfill.test.ts app/api/payroll/gl-reports/backfill/route.ts
git commit -m "feat(payroll): add dry-runnable GL report backfill"
```

**Acceptance:** Dry-run writes nothing and reports per-period before/after; manual overrides survive a live run.

---

## Post-Implementation (orchestrator only)

1. Final whole-branch review — **Opus**, once. Do not skip under budget pressure.
2. Apply `20260823` + `20260824` to prod after verifying `schema_migrations` has no prefix collision, with a backup taken first.
3. Set the tips account in Finance → Settings → Payroll Departments (should already be seeded).
4. Run the backfill with `dryRun: true` and review the per-period before/after against the spec's expectation of ~$900–$1,050 per period moving out of wage accounts.
5. Only then run with `dryRun: false`.
6. Confirm on the Financials page: Direct Production Labor drops, gross margin improves, and the tips liability appears on the balance sheet at roughly Σcollected − Σdisbursed.
