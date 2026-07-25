# GL Account Filter Implementation Plan

**Goal:** Filter Finance > Transactions by chart-of-accounts account on all four subtabs, narrowing multi-line rows to matching lines and showing a matching subtotal.

**Execution Budget:** Mode = **inline** (6 files, CLAUDE.md's 4–6 file tier). **Spawn cap = 0** — no subagents. Token target ≈ 60k.

**Spec:** `docs/superpowers/specs/2026-07-24-gl-account-filter-transactions-design.md`

## Global Constraints

- Filter param is `gl`; its value is a `chart_of_accounts.id`. Rides existing `useTableControls` (already URL-synced).
- Reuse `AccountSelect` (default export, `../../AccountSelect`, with `type CoARef`). Do NOT use `FilterSelect` — 126 accounts.
- No raw colors, no hand-rolled primitives, no arbitrary sizing. Secondary total uses `text-faint` + `text-2xs`.
- When no GL filter is active, every page must render byte-identically to today. The filtered presentation is additive only.
- `npm run verify` green before each commit.

---

### Task 1: Shared match/narrow helpers

**Files:** create `lib/finance/glLineMatch.ts`, `lib/finance/glLineMatch.test.ts`

**Interfaces:**
```ts
export function matchesGlFilter(lineCoaIds: (string | null | undefined)[], selected: string[]): boolean
export function narrowToGl<T>(lines: T[], coaIdOf: (line: T) => string | null | undefined, selected: string[]): T[]
```

Empty `selected` means "no filter": `matchesGlFilter` returns true, `narrowToGl` returns `lines` unchanged (same reference is fine).

**Tests (TDD — write first, watch fail):**
- `matchesGlFilter`: empty selection → true; one id in selection → true; none in selection → false; `null`/`undefined` entries ignored; empty `lineCoaIds` with a non-empty selection → false.
- `narrowToGl`: empty selection → all lines; narrows to matching subset; `[]` when none match; preserves input order; ignores lines whose id is null.

**Done when:** `npx vitest run lib/finance/glLineMatch.test.ts` passes.

---

### Task 2: The filter control

**Files:** create `app/finance/transactions/components/GlAccountFilter.tsx`

**Interface:**
```tsx
export default function GlAccountFilter({ accounts, value, onChange }: {
  accounts: CoARef[];
  value: string | null;                 // coa id, or null for "All"
  onChange: (coaId: string | null) => void;
}): JSX.Element
```

Renders a `label`-wrapped `AccountSelect` matching `FilterSelect`'s visual shape (`text-xs text-muted` label reading `GL account:`, control `w-auto`), with `placeholder="All accounts"`. Clearing the select passes `null`.

**Done when:** typechecks and renders inside a `FilterBar` without layout break.

---

### Task 3: Bank Ledger (simplest — no narrowing)

**Files:** modify `app/finance/transactions/bank-ledger/page.tsx`

- Add `{ param: "gl", accessor: (r) => r.chart_of_accounts_id ?? "" }` to `BANK_CONTROLS.filters`.
- Render `<GlAccountFilter>` in the FilterBar, wired to `filters.gl?.[0] ?? null` / `setFilter("gl", id ? [id] : [])`.
- The page already loads `accounts` for its inline CoA editor — reuse that state, do not re-fetch.

**Done when:** selecting an account filters rows; clearing restores all; row rendering is unchanged.

---

### Task 4: Expenses

**Files:** modify `app/finance/transactions/expenses/page.tsx`

- Filter: `{ param: "gl", matches: (e, sel) => matchesGlFilter(e.glLines.map((l) => l.chartOfAccountsId), sel) }`.
- Narrowing + subtotal: when `filters.gl` is non-empty, the amount cell shows the sum of `narrowToGl(e.glLines, l => l.chartOfAccountsId, sel)` amounts, with `of {full amount}` beneath in `text-2xs text-faint`.
- `SummaryStatBar`'s `totalSpend` sums the same matching amounts when the filter is active.
- Reuse the page's existing `accounts` state.

**Done when:** an unsplit expense shows an unchanged amount; a split expense coded across two accounts shows only the matching portion plus the `of …` context line.

---

### Task 5: Invoices

**Files:** modify `app/finance/transactions/invoices/page.tsx`

Same shape as Task 4, over `lineItems[].chart_of_accounts_id`. The expanded row lists only `narrowToGl(...)` line items while the filter is active. Row total shows the matching subtotal + `of {invoice total}`.

**Done when:** an invoice with one matching line of five shows that line only, its subtotal, and the full total as context.

---

### Task 6: Orders

**Files:** modify `app/finance/transactions/orders/page.tsx`

Same as Task 5, over `lineItems[].effective_chart_of_accounts_id` (note: `effective_`, which already resolves the mapping fallback — do not use the raw `chart_of_accounts_id`).

**Done when:** as Task 5, for orders.

---

## Definition of Done

- [ ] `npm run verify` green.
- [ ] With no `?gl=` param, all four pages render as before.
- [ ] Browser check on each subtab: select an account, confirm narrowing + subtotal + `of …` context, then clear.
- [ ] PR notes that this stacks on PR #266 and needs no migration.
