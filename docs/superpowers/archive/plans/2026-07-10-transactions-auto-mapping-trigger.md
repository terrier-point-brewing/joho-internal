# Transactions Auto-Mapping Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-mapping fires automatically for every new/changed finance row (orders, invoices, expenses, bank ledger) both when rows arrive (ingest) and when a mapping rule is created/edited (retroactive back-fill), so the manual "Auto-map all" button is a redundant safety net rather than a required step.

**Architecture:** Keep the mapping logic in the application layer (`lib/finance/`), never in a Postgres trigger, so all four sources reuse one set of TS resolvers. Extract the three existing inline auto-map route bodies into pure, unit-tested resolver functions plus thin IO wrappers in a new `lib/finance/autoMap.ts`. Two triggers invoke those wrappers: (1) **ingest** — every sync path already fill-maps POS + expenses inline; we close the two holes (invoice line items are not synced by the webhook at all; bank-ledger rows never resolve an account at ingest); (2) **rule mutation** — the rule-edit routes cascade a scoped back-fill to already-ingested rows (GL rules already do; catalog-variation and counterparty rules do not).

**Tech Stack:** Next.js 16 App Router route handlers, TypeScript, Supabase Postgres (admin client), Vitest for pure-logic tests, Ramp + Square raw-`fetch` clients.

## Global Constraints

- **No business logic in `app/api/**`** — extract to `lib/`. The three existing auto-map route handlers currently violate this; this plan fixes that as a side effect. (CLAUDE.md, Architecture Priorities)
- **Reuse existing tables/routes** — do not fork new parallel structures. Bank-ledger auto-map reuses `expense_counterparty_mappings` (keyed by `counterparty_key`), matching how bank-sourced *expenses* already resolve. (CLAUDE.md)
- **Fill-nulls-only mapping convention** — auto-map never overwrites a non-null `chart_of_accounts_id` and never touches `mapping_source = 'manual'`. Existing routes and `resolveLineItemCoa`/`resolveExpenseMapping` already follow this; every new resolver MUST too.
- **Pure logic gets co-located `*.test.ts`; keep `lib/` coverage ≥ the vitest floor** (`lines: 86`, `statements: 86` in `vitest.config.ts`). IO wrappers (Supabase reads/writes) follow the codebase pattern of NOT being mocked in tests — only the pure decision functions are unit-tested (see `bankLedger.test.ts`). (CLAUDE.md)
- **Schema changes = a new migration file** under `supabase/migrations/`; never hand-edit an applied migration. Migrations to prod are applied MANUALLY by the user after explicit OK + backup — a subagent NEVER applies a migration to the live prod DB. (CLAUDE.md, memory `feedback_prod_db_migration_authorization`)
- **Auth:** every route keeps its existing `requireRole([...])` gate unchanged.
- **Idempotency:** all triggers are safe to run repeatedly (overlapping webhook + cron deliveries are expected).
- Migration timestamp convention in this repo is `YYYYMMDD_name.sql` (latest is `20260725_ramp_bank_ledger.sql`). A `20260726_taproom_sync_lock.sql` already exists+applied to prod, so use `20260727_bank_ledger_counterparty_key.sql` to sort cleanly after it.

---

## Current-State Reference (read before starting)

Auto-map wiring today, per source:

| Source | Table | Ingest maps inline? | Rule-edit cascades? | Manual button route |
|---|---|---|---|---|
| Orders (POS) | `pos_line_items` | ✅ `syncPosTransactions` via `buildCoaResolvers` | ❌ `account-mappings` PATCH/bulk do not | `POST /api/finance/transactions/auto-map?year=` |
| Invoices | `invoice_line_items` | ✅ but only on **manual** `sync-square`/export — webhook does NOT sync line items | ❌ `account-mappings` PATCH/bulk do not | `POST /api/finance/ledger/invoices/auto-map?year=` |
| Expenses | `expenses` | ✅ `rampExpenses` via GL + counterparty rules | ✅ GL rule PATCH cascades (`expense-mappings/route.ts:71`); counterparty PATCH does NOT | `POST /api/finance/expenses/auto-map?from=&to=` |
| Bank ledger | `ramp_bank_ledger` | ❌ always `mapping_source:'unmapped'` (`bankLedger.ts:182`) | ❌ none | none (manual per-row PATCH only) |

Key existing pure functions to reuse:
- `resolveExpenseMapping(expense, glRules, counterpartyRules)` in `lib/finance/expenses.ts` — priority manual → GL rule → counterparty rule → unmapped.
- `resolveLineItemCoa(existing, prefill)` in `lib/finance/syncSquareInvoices.ts` — fill-nulls-only for invoice line items.
- `normalizeCounterparty(name)` in `lib/ramp` — produces the `counterparty_key` from a party name.

---

## File Structure

**Create:**
- `supabase/migrations/20260727_bank_ledger_counterparty_key.sql` — add `counterparty_key` to `ramp_bank_ledger`, backfill from `counterparty_name`.
- `lib/finance/autoMap.ts` — pure back-fill resolvers + thin IO wrappers for all four sources. One home for retroactive auto-map, consumed by the manual-button routes AND the rule-mutation routes.
- `lib/finance/autoMap.test.ts` — unit tests for the pure resolvers.

**Modify:**
- `lib/finance/bankLedger.ts` — add `counterparty_key` to `BankLedgerRecord`; resolve `chart_of_accounts_id` from counterparty rules at ingest in `syncBankLedger`.
- `lib/finance/bankLedger.test.ts` — cover the new pure resolver.
- `app/api/finance/transactions/auto-map/route.ts` — thin caller of `autoMapPosLineItems`.
- `app/api/finance/ledger/invoices/auto-map/route.ts` — thin caller of `autoMapInvoiceLineItems`.
- `app/api/finance/expenses/auto-map/route.ts` — thin caller of `autoMapExpenses`.
- `app/api/finance/account-mappings/route.ts` — PATCH cascades a scoped POS + invoice back-fill.
- `app/api/finance/account-mappings/bulk/route.ts` — POST cascades a scoped POS + invoice back-fill.
- `app/api/finance/expense-counterparty-mappings/route.ts` — PATCH cascades expenses + bank-ledger back-fill.
- `app/api/webhooks/square/route.ts` — invoice events also sync + auto-map that invoice's line items (not just status reconcile).
- `app/api/cron/finance-sync/route.ts` — safety-net invoice line-item sync for the trailing window.

**Interfaces exported by `lib/finance/autoMap.ts` (every later task depends on these exact names):**

```ts
// Pure resolvers — take already-fetched rows + rules, return the rows to update.
export function resolvePosBackfill(
  lineItems: { id: string; square_variation_id: string | null }[],
  coaByVarId: Map<string, string>,
): { id: string; chart_of_accounts_id: string }[];

export function resolveInvoiceBackfill(
  allItems: { id: string; description: string | null; chart_of_accounts_id: string | null }[],
  variationDescriptions: Map<string, string>, // description(lowercased) → coaId, from catalog variations
): { id: string; chart_of_accounts_id: string }[];

export function resolveBankBackfill(
  rows: { id: string; counterparty_key: string | null; mapping_source: string; chart_of_accounts_id: string | null }[],
  counterpartyRules: Map<string, string>, // counterparty_key → coaId
): { id: string; chart_of_accounts_id: string }[];

// IO wrappers — fetch, resolve, apply; return { mapped }. `scope` narrows the
// retroactive pass to a single rule's key (rule-edit trigger) or a whole year/range
// (manual button). Omitting the narrowing field means "all rows in range".
export async function autoMapPosLineItems(
  supabase: AdminClient,
  opts: { year: number; variationIds?: string[] },
): Promise<{ mapped: number; errors?: string[] }>;

export async function autoMapInvoiceLineItems(
  supabase: AdminClient,
  opts: { year: number; variationIds?: string[] },
): Promise<{ mapped: number; errors?: string[] }>;

export async function autoMapExpenses(
  supabase: AdminClient,
  opts: { from: string; to: string; externalAccountId?: string },
): Promise<{ mapped: number }>;

export async function autoMapBankLedger(
  supabase: AdminClient,
  opts: { from: string; to: string; counterpartyKey?: string },
): Promise<{ mapped: number; errors?: string[] }>;
```

Where `type AdminClient = ReturnType<typeof import("@/lib/supabase/admin").createSupabaseAdminClient>`.

---

## Task 1: Migration — `counterparty_key` on `ramp_bank_ledger`

Bank-ledger rows store `counterparty_name` but not the normalized `counterparty_key` that `expense_counterparty_mappings` is keyed on. Add the column and backfill it so bank-ledger auto-map can join to the existing counterparty rules table without recomputing the key on every read.

**Files:**
- Create: `supabase/migrations/20260727_bank_ledger_counterparty_key.sql`

**Interfaces:**
- Produces: `ramp_bank_ledger.counterparty_key text` (nullable), index `ramp_bank_ledger_counterparty_key_idx`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260727_bank_ledger_counterparty_key.sql`:

```sql
-- Bank-ledger rows currently store only counterparty_name. Auto-mapping resolves
-- an account from expense_counterparty_mappings, which is keyed on the normalized
-- counterparty_key (lowercased/trimmed). Persist that key on each ledger row so the
-- auto-map join is a simple equality, consistent with how expenses store it.
alter table public.ramp_bank_ledger
  add column if not exists counterparty_key text;

-- Backfill existing rows: lower(trim(collapse-whitespace(counterparty_name))).
-- Mirrors normalizeCounterparty() in lib/ramp so historical rows resolve the same
-- way freshly-synced rows will.
update public.ramp_bank_ledger
   set counterparty_key = lower(trim(regexp_replace(counterparty_name, '\s+', ' ', 'g')))
 where counterparty_key is null
   and counterparty_name is not null;

create index if not exists ramp_bank_ledger_counterparty_key_idx
  on public.ramp_bank_ledger (counterparty_key);
```

- [ ] **Step 2: Verify `normalizeCounterparty` matches the SQL backfill**

Read `lib/ramp` `normalizeCounterparty`. Confirm it is `name.trim().toLowerCase()` with internal-whitespace collapse. If it also strips punctuation or does more, update the SQL `regexp_replace`/`lower`/`trim` chain to match exactly, so backfilled keys equal keys written at ingest.

Run: `grep -n "export function normalizeCounterparty" -A6 lib/ramp/*.ts`
Expected: a definition whose transform the SQL reproduces character-for-character.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260727_bank_ledger_counterparty_key.sql
git commit -m "feat(finance): add counterparty_key to ramp_bank_ledger for auto-map join"
```

> **DO NOT apply to prod.** Migration application to the live Supabase project is a manual, user-authorized step (backup first). Flag it at hand-off; the code in later tasks must tolerate the column being absent only insofar as local/preview DBs have it applied via `supabase db push` in the dev environment.

---

## Task 2: Bank-ledger auto-map at ingest + pure resolver

Resolve `chart_of_accounts_id` for bank-ledger rows from counterparty rules, both at ingest (in `syncBankLedger`) and retroactively (the pure `resolveBankBackfill`, used by Task 7 and the future manual path). Manual pins are always preserved.

**Files:**
- Modify: `lib/finance/bankLedger.ts`
- Test: `lib/finance/bankLedger.test.ts`
- Create (stub, filled in Task 3): `lib/finance/autoMap.ts` — add `resolveBankBackfill` here.
- Test: `lib/finance/autoMap.test.ts`

**Interfaces:**
- Consumes: `normalizeCounterparty` from `@/lib/ramp`; `resolveExpenseMapping` pattern from `lib/finance/expenses.ts`.
- Produces: `BankLedgerRecord.counterparty_key: string | null`; `resolveBankBackfill(rows, counterpartyRules)` in `autoMap.ts`.

- [ ] **Step 1: Write the failing test for `resolveBankBackfill`**

Create `lib/finance/autoMap.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveBankBackfill } from "./autoMap";

describe("resolveBankBackfill", () => {
  const rules = new Map<string, string>([["gusto", "coa-payroll"]]);

  it("maps an unmapped row whose counterparty has a rule", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", counterparty_key: "gusto", mapping_source: "unmapped", chart_of_accounts_id: null }],
      rules,
    );
    expect(out).toEqual([{ id: "r1", chart_of_accounts_id: "coa-payroll" }]);
  });

  it("never overwrites a manual pin", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", counterparty_key: "gusto", mapping_source: "manual", chart_of_accounts_id: "coa-x" }],
      rules,
    );
    expect(out).toEqual([]);
  });

  it("never overwrites an already-mapped row (fill-nulls-only)", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", counterparty_key: "gusto", mapping_source: "rule", chart_of_accounts_id: "coa-old" }],
      rules,
    );
    expect(out).toEqual([]);
  });

  it("skips rows whose counterparty has no rule", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", counterparty_key: "unknown", mapping_source: "unmapped", chart_of_accounts_id: null }],
      rules,
    );
    expect(out).toEqual([]);
  });

  it("skips rows with a null counterparty_key", () => {
    const out = resolveBankBackfill(
      [{ id: "r1", counterparty_key: null, mapping_source: "unmapped", chart_of_accounts_id: null }],
      rules,
    );
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- autoMap`
Expected: FAIL — `Cannot find module './autoMap'` / `resolveBankBackfill is not a function`.

- [ ] **Step 3: Create `lib/finance/autoMap.ts` with `resolveBankBackfill`**

Create `lib/finance/autoMap.ts`:

```ts
/**
 * Retroactive auto-mapping. One home for "fill the account on already-ingested,
 * still-unmapped rows" across all four finance sources. Pure resolvers decide the
 * updates (unit-tested); thin IO wrappers fetch rows + rules and apply the writes.
 *
 * Every resolver is fill-nulls-only and never touches a manual pin — the same
 * convention the ingest paths and the (soon thin) manual-button routes follow.
 */

/** Bank-ledger rows: map from counterparty rules, preserving manual + existing. */
export function resolveBankBackfill(
  rows: { id: string; counterparty_key: string | null; mapping_source: string; chart_of_accounts_id: string | null }[],
  counterpartyRules: Map<string, string>,
): { id: string; chart_of_accounts_id: string }[] {
  const updates: { id: string; chart_of_accounts_id: string }[] = [];
  for (const row of rows) {
    if (row.mapping_source === "manual") continue;
    if (row.chart_of_accounts_id) continue;
    if (!row.counterparty_key) continue;
    const coaId = counterpartyRules.get(row.counterparty_key);
    if (coaId) updates.push({ id: row.id, chart_of_accounts_id: coaId });
  }
  return updates;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- autoMap`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing test for `counterparty_key` at bank-ledger ingest**

In `lib/finance/bankLedger.test.ts`, add a case asserting the ledger record now carries `counterparty_key`. `bankLineToLedgerRecord` is not exported; assert via `partitionBankLines` instead:

```ts
it("ledger records carry the normalized counterparty_key for auto-map", () => {
  // A Deposit from an outside bank is ledger-bound (not an expense) and has a
  // counterparty; its key must be persisted so counterparty rules can map it.
  const { ledgerRecords } = partitionBankLines(
    [line({ description: "Deposit", source_account_name: "STRIPE PAYMENTS", destination_account_name: "Operating Account" })],
    OWN,
  );
  expect(ledgerRecords[0]).toMatchObject({ counterparty_key: normalizeCounterparty("STRIPE PAYMENTS") });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm run test -- bankLedger`
Expected: FAIL — `counterparty_key` is `undefined` on the ledger record.

- [ ] **Step 7: Add `counterparty_key` to `BankLedgerRecord` + `bankLineToLedgerRecord`**

In `lib/finance/bankLedger.ts`, add the field to the interface (after `counterparty_name`):

```ts
  counterparty_name:        string | null;
  counterparty_key:         string | null;
```

And set it in `bankLineToLedgerRecord` (alongside `counterparty_name`):

```ts
    counterparty_name:        c.counterparty_name || null,
    counterparty_key:         c.counterparty_key || null,
```

(`BankClassification` already carries `counterparty_key` — see `bankLedger.ts:50` and the `classifyBankLine` test asserting `counterparty_key: "gusto"`.)

- [ ] **Step 8: Run it to verify it passes**

Run: `npm run test -- bankLedger`
Expected: PASS.

- [ ] **Step 9: Resolve accounts at ingest in `syncBankLedger`**

In `lib/finance/bankLedger.ts` `syncBankLedger`, after the existing block that loads prior rows into `existing` and before building `rows`, load counterparty rules and apply them for non-manual, unmapped rows. Replace the current `chart_of_accounts_id`/`mapping_source` assignment (`bankLedger.ts:182-183`).

Add the rules load (near the top of `syncBankLedger`, after `existing` is built):

```ts
  // Counterparty rules — the same table bank-sourced expenses resolve against.
  const { data: cpRuleRows, error: cpRuleErr } = await supabase
    .from("expense_counterparty_mappings")
    .select("counterparty_key, chart_of_accounts_id")
    .eq("source", "ramp")
    .not("chart_of_accounts_id", "is", null);
  if (cpRuleErr) throw new Error(`Load counterparty mappings failed: ${cpRuleErr.message}`);
  const coaByCounterparty = new Map<string, string>(
    (cpRuleRows ?? []).map((r) => [r.counterparty_key as string, r.chart_of_accounts_id as string]),
  );
```

Then in the `records.map((rec) => { ... })`, replace the manual/unmapped assignment with rule resolution:

```ts
    const prior = existing.get(rec.source_transaction_id);
    const manual = prior?.mapping_source === "manual";
    const flow_type  = manual ? prior!.flow_type  : rec.flow_type;
    const affects_pl = manual ? prior!.affects_pl : rec.affects_pl;
    by_flow_type[flow_type] = (by_flow_type[flow_type] ?? 0) + 1;

    // Fill-nulls-only: manual pin wins; else a prior rule/manual account survives
    // re-sync; else resolve fresh from a counterparty rule; else unmapped.
    let chart_of_accounts_id: string | null;
    let mapping_source: string;
    if (manual) {
      chart_of_accounts_id = prior!.chart_of_accounts_id;
      mapping_source = "manual";
    } else if (prior?.chart_of_accounts_id) {
      chart_of_accounts_id = prior.chart_of_accounts_id;
      mapping_source = prior.mapping_source;
    } else {
      const ruleCoa = rec.counterparty_key ? coaByCounterparty.get(rec.counterparty_key) ?? null : null;
      chart_of_accounts_id = ruleCoa;
      mapping_source = ruleCoa ? "rule" : "unmapped";
    }
    return { ...rec, flow_type, affects_pl, chart_of_accounts_id, mapping_source, synced_at: syncedAt };
```

Note: the `existing` map must now also select `mapping_source` for the non-manual branch — it already selects `mapping_source, chart_of_accounts_id` (`bankLedger.ts:156`), so no change needed there. The upsert row list now includes `counterparty_key` (from `...rec`), which the migration added to the table.

- [ ] **Step 10: Run the bank-ledger + auto-map suites**

Run: `npm run test -- bankLedger autoMap`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add lib/finance/bankLedger.ts lib/finance/bankLedger.test.ts lib/finance/autoMap.ts lib/finance/autoMap.test.ts
git commit -m "feat(finance): resolve bank-ledger accounts from counterparty rules at ingest"
```

---

## Task 3: Extract POS + invoice + expense auto-map into `lib/finance/autoMap.ts`

Move the three inline route bodies into pure resolvers + IO wrappers. The pure functions get tests; the wrappers reproduce the existing route behavior exactly, plus accept an optional narrowing key (`variationIds` / `externalAccountId`) used by the rule-edit trigger in Tasks 6–7.

**Files:**
- Modify: `lib/finance/autoMap.ts`
- Test: `lib/finance/autoMap.test.ts`

**Interfaces:**
- Consumes: `resolveBankBackfill` (Task 2) already present.
- Produces: `resolvePosBackfill`, `resolveInvoiceBackfill`, `autoMapPosLineItems`, `autoMapInvoiceLineItems`, `autoMapExpenses`, `autoMapBankLedger` (signatures in the File Structure block).

- [ ] **Step 1: Write the failing tests for the pure POS + invoice resolvers**

Append to `lib/finance/autoMap.test.ts`:

```ts
import { resolvePosBackfill, resolveInvoiceBackfill } from "./autoMap";

describe("resolvePosBackfill", () => {
  const coaByVar = new Map<string, string>([["v1", "coa-beer"]]);

  it("maps unmapped line items whose variation has a mapping", () => {
    const out = resolvePosBackfill([{ id: "li1", square_variation_id: "v1" }], coaByVar);
    expect(out).toEqual([{ id: "li1", chart_of_accounts_id: "coa-beer" }]);
  });

  it("skips items with no variation or no mapping", () => {
    const out = resolvePosBackfill(
      [{ id: "li1", square_variation_id: null }, { id: "li2", square_variation_id: "vX" }],
      coaByVar,
    );
    expect(out).toEqual([]);
  });
});

describe("resolveInvoiceBackfill", () => {
  const byDesc = new Map<string, string>([["hazy ipa — 1/6 bbl", "coa-dist"]]);

  it("maps an unmapped item by lowercased description", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", description: "Hazy IPA — 1/6 BBL", chart_of_accounts_id: null }],
      byDesc,
    );
    expect(out).toEqual([{ id: "il1", chart_of_accounts_id: "coa-dist" }]);
  });

  it("never overwrites an already-mapped item", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", description: "Hazy IPA — 1/6 BBL", chart_of_accounts_id: "coa-x" }],
      byDesc,
    );
    expect(out).toEqual([]);
  });

  it("skips items whose description has no match", () => {
    const out = resolveInvoiceBackfill(
      [{ id: "il1", description: "Mystery", chart_of_accounts_id: null }],
      byDesc,
    );
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- autoMap`
Expected: FAIL — `resolvePosBackfill`/`resolveInvoiceBackfill` not exported.

- [ ] **Step 3: Add the pure resolvers to `autoMap.ts`**

Append to `lib/finance/autoMap.ts`:

```ts
/** POS line items: map from catalog-variation → CoA. */
export function resolvePosBackfill(
  lineItems: { id: string; square_variation_id: string | null }[],
  coaByVarId: Map<string, string>,
): { id: string; chart_of_accounts_id: string }[] {
  const updates: { id: string; chart_of_accounts_id: string }[] = [];
  for (const li of lineItems) {
    if (!li.square_variation_id) continue;
    const coaId = coaByVarId.get(li.square_variation_id);
    if (coaId) updates.push({ id: li.id, chart_of_accounts_id: coaId });
  }
  return updates;
}

/** Invoice line items: map from a description(lowercased) → CoA index. */
export function resolveInvoiceBackfill(
  allItems: { id: string; description: string | null; chart_of_accounts_id: string | null }[],
  descToCoa: Map<string, string>,
): { id: string; chart_of_accounts_id: string }[] {
  const updates: { id: string; chart_of_accounts_id: string }[] = [];
  for (const item of allItems) {
    if (item.chart_of_accounts_id) continue;
    if (!item.description) continue;
    const coaId = descToCoa.get(item.description.trim().toLowerCase());
    if (coaId) updates.push({ id: item.id, chart_of_accounts_id: coaId });
  }
  return updates;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test -- autoMap`
Expected: PASS.

- [ ] **Step 5: Add the IO wrappers to `autoMap.ts`**

Append to `lib/finance/autoMap.ts` (imports at top of file):

```ts
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveExpenseMapping } from "./expenses";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
```

Then the wrappers. `autoMapPosLineItems` reproduces `transactions/auto-map/route.ts`, adding the optional `variationIds` narrowing:

```ts
export async function autoMapPosLineItems(
  supabase: AdminClient,
  opts: { year: number; variationIds?: string[] },
): Promise<{ mapped: number; errors?: string[] }> {
  const startDate = `${opts.year}-01-01`;
  const endDate   = `${opts.year + 1}-01-01`;

  const { data: orders, error: ordersErr } = await supabase
    .from("square_orders")
    .select("id")
    .gte("transaction_date", startDate)
    .lt("transaction_date", endDate)
    .is("invoice_id", null);
  if (ordersErr) throw new Error(ordersErr.message);
  const orderIds = (orders ?? []).map((o) => o.id);
  if (orderIds.length === 0) return { mapped: 0 };

  let liQuery = supabase
    .from("pos_line_items")
    .select("id, square_variation_id")
    .is("chart_of_accounts_id", null)
    .not("square_variation_id", "is", null)
    .in("square_order_id", orderIds);
  if (opts.variationIds && opts.variationIds.length > 0) {
    liQuery = liQuery.in("square_variation_id", opts.variationIds);
  }
  const { data: lineItems, error: liErr } = await liQuery;
  if (liErr) throw new Error(liErr.message);
  if (!lineItems || lineItems.length === 0) return { mapped: 0 };

  const varIds = opts.variationIds && opts.variationIds.length > 0
    ? opts.variationIds
    : [...new Set(lineItems.map((li) => li.square_variation_id as string))];
  const { data: mappings, error: mapErr } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, chart_of_accounts_id")
    .in("square_variation_id", varIds)
    .not("chart_of_accounts_id", "is", null);
  if (mapErr) throw new Error(mapErr.message);

  const coaByVarId = new Map<string, string>(
    (mappings ?? []).map((m) => [m.square_variation_id as string, m.chart_of_accounts_id as string]),
  );
  const updates = resolvePosBackfill(lineItems, coaByVarId);
  return applyLineItemUpdates(supabase, "pos_line_items", updates);
}
```

`autoMapInvoiceLineItems` reproduces `ledger/invoices/auto-map/route.ts` (description-from-mapped-siblings + catalog-variation index), adding `variationIds` narrowing that restricts which variation-derived descriptions are added:

```ts
export async function autoMapInvoiceLineItems(
  supabase: AdminClient,
  opts: { year: number; variationIds?: string[] },
): Promise<{ mapped: number; errors?: string[] }> {
  const { data: allItems, error } = await supabase
    .from("invoice_line_items")
    .select("id, description, chart_of_accounts_id, invoices!invoice_line_items_invoice_id_fkey!inner(invoice_date)")
    .gte("invoices.invoice_date", `${opts.year}-01-01`)
    .lte("invoices.invoice_date", `${opts.year}-12-31`);
  if (error) throw new Error(error.message);
  if (!allItems || allItems.length === 0) return { mapped: 0 };

  const descToCoa = new Map<string, string>();
  // Source 1: description → CoA from already-mapped siblings.
  for (const item of allItems) {
    if (item.chart_of_accounts_id && item.description) {
      descToCoa.set(item.description.trim().toLowerCase(), item.chart_of_accounts_id as string);
    }
  }
  // Source 2: catalog variation mappings, keyed "item_name — variation_name" and plain item_name.
  let varQuery = supabase
    .from("square_catalog_variations")
    .select("square_variation_id, variation_name, chart_of_accounts_id, chart_of_accounts_id_invoice, square_catalog_items ( item_name )")
    .or("chart_of_accounts_id.not.is.null,chart_of_accounts_id_invoice.not.is.null");
  if (opts.variationIds && opts.variationIds.length > 0) {
    varQuery = varQuery.in("square_variation_id", opts.variationIds);
  }
  const { data: variations } = await varQuery;
  for (const v of variations ?? []) {
    const itemName = (v.square_catalog_items as unknown as { item_name: string } | null)?.item_name;
    if (!itemName) continue;
    const coaId = (v.chart_of_accounts_id_invoice ?? v.chart_of_accounts_id) as string | null;
    if (!coaId) continue;
    const key = `${itemName} — ${v.variation_name}`.trim().toLowerCase();
    if (!descToCoa.has(key)) descToCoa.set(key, coaId);
    const plainKey = itemName.trim().toLowerCase();
    if (!descToCoa.has(plainKey)) descToCoa.set(plainKey, coaId);
  }

  const updates = resolveInvoiceBackfill(allItems, descToCoa);
  return applyLineItemUpdates(supabase, "invoice_line_items", updates);
}
```

`autoMapExpenses` reproduces `expenses/auto-map/route.ts` (per-rule bulk update), adding `externalAccountId` narrowing:

```ts
export async function autoMapExpenses(
  supabase: AdminClient,
  opts: { from: string; to: string; externalAccountId?: string },
): Promise<{ mapped: number }> {
  let ruleQuery = supabase
    .from("expense_account_mappings")
    .select("source, external_account_id, chart_of_accounts_id")
    .not("chart_of_accounts_id", "is", null);
  if (opts.externalAccountId) ruleQuery = ruleQuery.eq("external_account_id", opts.externalAccountId);
  const { data: rules, error: ruleErr } = await ruleQuery;
  if (ruleErr) throw new Error(ruleErr.message);

  let mapped = 0;
  for (const rule of rules ?? []) {
    const { data: affected, error } = await supabase
      .from("expenses")
      .update({ chart_of_accounts_id: rule.chart_of_accounts_id, mapping_source: "rule" })
      .eq("source", rule.source)
      .eq("external_account_id", rule.external_account_id)
      .neq("mapping_source", "manual")
      .is("chart_of_accounts_id", null)
      .gte("accounting_date", opts.from)
      .lte("accounting_date", opts.to)
      .select("id");
    if (error) throw new Error(error.message);
    mapped += affected?.length ?? 0;
  }
  return { mapped };
}
```

`autoMapBankLedger` (new capability — the retroactive counterpart to Task 2's ingest mapping):

```ts
export async function autoMapBankLedger(
  supabase: AdminClient,
  opts: { from: string; to: string; counterpartyKey?: string },
): Promise<{ mapped: number; errors?: string[] }> {
  let rowQuery = supabase
    .from("ramp_bank_ledger")
    .select("id, counterparty_key, mapping_source, chart_of_accounts_id")
    .is("chart_of_accounts_id", null)
    .neq("mapping_source", "manual")
    .gte("transaction_date", opts.from)
    .lte("transaction_date", opts.to);
  if (opts.counterpartyKey) rowQuery = rowQuery.eq("counterparty_key", opts.counterpartyKey);
  const { data: rows, error } = await rowQuery;
  if (error) throw new Error(error.message);
  if (!rows || rows.length === 0) return { mapped: 0 };

  let cpQuery = supabase
    .from("expense_counterparty_mappings")
    .select("counterparty_key, chart_of_accounts_id")
    .eq("source", "ramp")
    .not("chart_of_accounts_id", "is", null);
  if (opts.counterpartyKey) cpQuery = cpQuery.eq("counterparty_key", opts.counterpartyKey);
  const { data: cpRules, error: cpErr } = await cpQuery;
  if (cpErr) throw new Error(cpErr.message);

  const rules = new Map<string, string>((cpRules ?? []).map((r) => [r.counterparty_key as string, r.chart_of_accounts_id as string]));
  const updates = resolveBankBackfill(rows, rules);
  return applyLineItemUpdates(supabase, "ramp_bank_ledger", updates, { mapping_source: "rule" });
}
```

Shared apply helper (add near the top of the file, after the type alias):

```ts
/** Apply per-row CoA updates in bounded parallel chunks. Returns { mapped, errors? }. */
async function applyLineItemUpdates(
  supabase: AdminClient,
  table: "pos_line_items" | "invoice_line_items" | "ramp_bank_ledger",
  updates: { id: string; chart_of_accounts_id: string }[],
  extra?: Record<string, unknown>,
): Promise<{ mapped: number; errors?: string[] }> {
  if (updates.length === 0) return { mapped: 0 };
  const CHUNK = 100;
  let mapped = 0;
  const errors: string[] = [];
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      chunk.map((u) =>
        supabase.from(table).update({ chart_of_accounts_id: u.chart_of_accounts_id, ...extra }).eq("id", u.id),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && !r.value.error) mapped++;
      else if (r.status === "rejected") errors.push(String(r.reason));
      else if (r.status === "fulfilled" && r.value.error) errors.push(r.value.error.message);
    }
  }
  return { mapped, errors: errors.length ? errors : undefined };
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run lint`
Expected: no errors in `lib/finance/autoMap.ts`. (Adjust any Supabase generic typing the linter flags, e.g. narrowing `m.chart_of_accounts_id` casts, to match the repo's existing style in the original routes.)

- [ ] **Step 7: Run the full auto-map test suite**

Run: `npm run test -- autoMap`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/finance/autoMap.ts lib/finance/autoMap.test.ts
git commit -m "feat(finance): extract per-source auto-map resolvers + IO wrappers into lib"
```

---

## Task 4: Make the three manual-button routes thin callers

Replace each auto-map route body with a call to its lib wrapper. Behavior for the manual "Auto-map all" button is unchanged; the logic now lives in one place.

**Files:**
- Modify: `app/api/finance/transactions/auto-map/route.ts`
- Modify: `app/api/finance/ledger/invoices/auto-map/route.ts`
- Modify: `app/api/finance/expenses/auto-map/route.ts`

**Interfaces:**
- Consumes: `autoMapPosLineItems`, `autoMapInvoiceLineItems`, `autoMapExpenses` from `lib/finance/autoMap.ts`.

- [ ] **Step 1: Rewrite `transactions/auto-map/route.ts`**

```ts
/**
 * POST /api/finance/transactions/auto-map?year=YYYY
 * Retroactively map unmapped POS line items in the year from catalog-variation
 * mappings. Logic lives in lib/finance/autoMap so the same pass runs from the
 * catalog-variation rule-edit trigger. Returns { mapped }.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { autoMapPosLineItems } from "@/lib/finance/autoMap";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const year = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const supabase = createSupabaseAdminClient();
  try {
    const result = await autoMapPosLineItems(supabase, { year });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "auto-map failed" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Rewrite `ledger/invoices/auto-map/route.ts`**

```ts
/**
 * POST /api/finance/ledger/invoices/auto-map?year=YYYY
 * Retroactively map unmapped invoice line items by description + catalog-variation
 * mappings. Logic lives in lib/finance/autoMap. Returns { mapped }.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { autoMapInvoiceLineItems } from "@/lib/finance/autoMap";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const year = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const supabase = createSupabaseAdminClient();
  try {
    const result = await autoMapInvoiceLineItems(supabase, { year });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "auto-map failed" }, { status: 500 });
  }
}
```

- [ ] **Step 3: Rewrite `expenses/auto-map/route.ts`**

```ts
/**
 * POST /api/finance/expenses/auto-map?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Re-apply source-account rules to unmapped, non-manual expenses in range. Logic
 * lives in lib/finance/autoMap. Returns { mapped }.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { autoMapExpenses } from "@/lib/finance/autoMap";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const from = req.nextUrl.searchParams.get("from");
  const to   = req.nextUrl.searchParams.get("to");
  if (!from || !to) return NextResponse.json({ error: "from and to required" }, { status: 400 });
  const supabase = createSupabaseAdminClient();
  try {
    const result = await autoMapExpenses(supabase, { from, to });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "auto-map failed" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Typecheck + build the routes**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Manual smoke test (local dev)**

Run: `npm run dev`, then from the Transactions tab click "Auto-map all" on Orders, Invoices, and Expenses subtabs; confirm each returns a count and unmapped rows get accounts. (Requires local DB with the Task 1 migration applied via `supabase db push`.)
Expected: same behavior as before the refactor.

- [ ] **Step 6: Commit**

```bash
git add app/api/finance/transactions/auto-map/route.ts app/api/finance/ledger/invoices/auto-map/route.ts app/api/finance/expenses/auto-map/route.ts
git commit -m "refactor(finance): auto-map routes call shared lib wrappers"
```

---

## Task 5: Cascade catalog-variation rule edits → POS + invoice back-fill

When a user maps a catalog variation to an account (single PATCH or bulk POST), immediately back-fill already-ingested unmapped POS and invoice line items for the affected variations across the current and prior year. This is the "created a rule after the rows arrived" trigger for orders + invoices.

**Files:**
- Modify: `app/api/finance/account-mappings/route.ts` (PATCH)
- Modify: `app/api/finance/account-mappings/bulk/route.ts` (POST)

**Interfaces:**
- Consumes: `autoMapPosLineItems`, `autoMapInvoiceLineItems` (with `variationIds`).

- [ ] **Step 1: Read both routes to identify the affected variation ids**

Read `account-mappings/route.ts` PATCH — it updates `square_catalog_variations` for one `square_variation_id` (from the request body). Read `bulk/route.ts` — `updateVariations(itemIds)` updates variations for a set of catalog items; capture the affected `square_variation_id`s by selecting them from the update `.select("square_variation_id")`.

- [ ] **Step 2: Add the cascade to the single PATCH**

In `account-mappings/route.ts` PATCH, after the successful `.update(patch)` on `square_catalog_variations`, add (using `after` so the response isn't blocked):

```ts
import { after } from "next/server";
import { autoMapPosLineItems, autoMapInvoiceLineItems } from "@/lib/finance/autoMap";
// ...
  // Back-fill already-ingested unmapped line items for this variation so the user
  // doesn't have to click "Auto-map all". Current + prior year covers open books.
  const variationId = body.square_variation_id as string; // the PATCH target
  if (variationId) {
    after(async () => {
      const years = [new Date().getFullYear(), new Date().getFullYear() - 1];
      for (const year of years) {
        try {
          await autoMapPosLineItems(supabase, { year, variationIds: [variationId] });
          await autoMapInvoiceLineItems(supabase, { year, variationIds: [variationId] });
        } catch (e) {
          console.error("[account-mappings] cascade auto-map failed", { variationId, year, error: e });
        }
      }
    });
  }
```

Confirm `body.square_variation_id` is the correct field name by reading the PATCH body parsing; if the route keys off a different identifier (e.g. `id`), select the `square_variation_id` back from the update via `.select("square_variation_id").single()` and use that.

- [ ] **Step 3: Add the cascade to the bulk POST**

In `bulk/route.ts`, change `updateVariations` to return the affected variation ids, then after all updates in each POST branch, cascade. Modify `updateVariations`:

```ts
    const { data, error } = await supabase
      .from("square_catalog_variations")
      .update(patch)
      .in("catalog_item_id", itemIds)   // keep the route's existing filter
      .select("square_variation_id");
    if (error) throw ...
    return (data ?? []).map((r) => r.square_variation_id as string);
```

(Keep whatever filter column the route already uses — read it; the point is to also `.select("square_variation_id")`.) Then, before returning each `NextResponse.json({ updated: count })`, capture ids and cascade:

```ts
  after(async () => {
    if (affectedVariationIds.length === 0) return;
    const years = [new Date().getFullYear(), new Date().getFullYear() - 1];
    for (const year of years) {
      try {
        await autoMapPosLineItems(supabase, { year, variationIds: affectedVariationIds });
        await autoMapInvoiceLineItems(supabase, { year, variationIds: affectedVariationIds });
      } catch (e) {
        console.error("[account-mappings/bulk] cascade auto-map failed", { count: affectedVariationIds.length, year, error: e });
      }
    }
  });
```

Where `count` becomes `affectedVariationIds.length` and each branch collects `affectedVariationIds` from `updateVariations`.

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: no errors. Ensure `after` is imported from `next/server` and `dynamic = "force-dynamic"` remains.

- [ ] **Step 5: Manual smoke test**

Run `npm run dev`; on Settings → Account Mapping, assign an account to a variation that has unmapped POS orders/invoice lines in the current year. Reload the Orders/Invoices subtabs; confirm those rows now show the account without pressing "Auto-map all".
Expected: rows auto-mapped within a moment of saving the rule.

- [ ] **Step 6: Commit**

```bash
git add app/api/finance/account-mappings/route.ts app/api/finance/account-mappings/bulk/route.ts
git commit -m "feat(finance): catalog-variation mapping edits back-fill POS + invoice rows"
```

---

## Task 6: Cascade counterparty rule edits → expenses + bank-ledger back-fill

The expense GL-rule PATCH already back-fills `expenses` (`expense-mappings/route.ts:71`). The counterparty-rule PATCH updates only the rule row — extend it to back-fill both bank-sourced expenses and bank-ledger rows for that counterparty.

**Files:**
- Modify: `app/api/finance/expense-counterparty-mappings/route.ts` (PATCH)

**Interfaces:**
- Consumes: `autoMapBankLedger` (with `counterpartyKey`).

- [ ] **Step 1: Read the current PATCH**

`expense-counterparty-mappings/route.ts:18-26` updates `expense_counterparty_mappings` for one rule (body has the rule row; capture its `counterparty_key` — select it back if the body only carries an `id`).

- [ ] **Step 2: Add the cascade after the rule update**

After the successful `.update({...})`, select the rule's `counterparty_key` and `chart_of_accounts_id`, then back-fill. Expenses back-fill mirrors the GL-rule route's pattern (direct update); bank-ledger uses the lib wrapper:

```ts
import { after } from "next/server";
import { autoMapBankLedger } from "@/lib/finance/autoMap";
// ... after the rule .update(...).select("counterparty_key, chart_of_accounts_id").single() → `rule`
  const counterpartyKey = rule.counterparty_key as string;
  const coaId = rule.chart_of_accounts_id as string | null;

  // Expenses: bank-sourced rows carrying this counterparty, non-manual, unmapped.
  let expensesUpdated = 0;
  if (coaId) {
    const { data: affected } = await supabase
      .from("expenses")
      .update({ chart_of_accounts_id: coaId, mapping_source: "rule" })
      .eq("source", "ramp")
      .eq("counterparty_key", counterpartyKey)
      .neq("mapping_source", "manual")
      .is("chart_of_accounts_id", null)
      .select("id");
    expensesUpdated = affected?.length ?? 0;
  }

  // Bank ledger: back-fill across current + prior year (open books) in the background.
  after(async () => {
    if (!coaId) return;
    const year = new Date().getFullYear();
    const ranges = [
      { from: `${year}-01-01`, to: `${year}-12-31` },
      { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` },
    ];
    for (const r of ranges) {
      try {
        await autoMapBankLedger(supabase, { ...r, counterpartyKey });
      } catch (e) {
        console.error("[counterparty-mappings] bank-ledger cascade failed", { counterpartyKey, range: r, error: e });
      }
    }
  });

  return NextResponse.json({ rule, expenses_updated: expensesUpdated });
```

Confirm the existing response shape and preserve it (add `expenses_updated` if the route didn't return it before; the invoices/expenses UI ignores extra fields).

- [ ] **Step 3: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Manual smoke test**

Assign an account to a counterparty (Settings → Counterparty Accounts) that has unmapped bank-ledger rows and bank-sourced expenses. Confirm both back-fill without pressing any button.
Expected: rows mapped shortly after saving.

- [ ] **Step 5: Commit**

```bash
git add app/api/finance/expense-counterparty-mappings/route.ts
git commit -m "feat(finance): counterparty rule edits back-fill expenses + bank ledger"
```

---

## Task 7: Sync + auto-map invoice line items on the invoice webhook + cron

The Square invoice webhook currently only reconciles invoice *status* — invoice line items never arrive via webhook, so a brand-new invoice's lines don't exist (let alone map) until someone clicks "Sync from Square." Add a per-year invoice sync (which itself fill-maps line items via `resolveLineItemCoa`) to the invoice webhook branch and as a cron safety net.

**Files:**
- Modify: `app/api/webhooks/square/route.ts`
- Modify: `app/api/cron/finance-sync/route.ts`

**Interfaces:**
- Consumes: `syncSquareInvoicesForYear` from `lib/finance/syncSquareInvoices.ts`; `autoMapInvoiceLineItems` from `lib/finance/autoMap.ts`.

- [ ] **Step 1: Extend the invoice webhook branch to sync line items**

In `app/api/webhooks/square/route.ts`, inside `after(...)`, in the `if (invoiceEvent) { ... }` block, after the existing `reconcileInvoiceStatus` call, sync that invoice's year so its line items land and fill-map. (Per-invoice sync isn't exposed; the year sync is idempotent and fill-nulls-only, so it's safe. It reuses the same Square fetch already used by the manual button.)

```ts
import { syncSquareInvoicesForYear } from "@/lib/finance/syncSquareInvoices";
import { autoMapInvoiceLineItems } from "@/lib/finance/autoMap";
// ... inside `if (invoiceEvent)`, after reconcileInvoiceStatus:
        try {
          const year = new Date().getFullYear();
          const syncResult = await syncSquareInvoicesForYear(supabase, year);
          const mapResult = await autoMapInvoiceLineItems(supabase, { year });
          console.log("[square-webhook] invoice line-item sync", {
            invoiceId, synced: syncResult.synced, updated: syncResult.updated, mapped: mapResult.mapped,
          });
        } catch (e) {
          console.error("[square-webhook] invoice line-item sync failed", e);
        }
```

> Note the current-year assumption: an invoice event for a prior-year invoice would sync the wrong year. If `extractSquareInvoiceId` / the event payload exposes the invoice's `created_at`, derive the year from it; otherwise the daily cron (next step) covers the trailing window and self-heals. Keep current-year here for the webhook's near-real-time path.

- [ ] **Step 2: Add invoice line-item sync to the finance-sync cron**

In `app/api/cron/finance-sync/route.ts`, inside `runCronJob`, after the existing order/refund/status reconcile, sync the current-year invoices + auto-map (safety net for missed webhook line-item syncs):

```ts
import { syncSquareInvoicesForYear } from "@/lib/finance/syncSquareInvoices";
import { autoMapInvoiceLineItems } from "@/lib/finance/autoMap";
// ... after invoicesReconciled loop, before the return:
    const year = new Date().getFullYear();
    const invoiceLineSync = await syncSquareInvoicesForYear(supabase, year);
    const invoiceAutoMap = await autoMapInvoiceLineItems(supabase, { year });

    return {
      windowDays: WINDOW_DAYS, orders, refunds, invoicesReconciled,
      invoiceLineSync: { synced: invoiceLineSync.synced, updated: invoiceLineSync.updated },
      invoiceAutoMapped: invoiceAutoMap.mapped,
    };
```

- [ ] **Step 3: Typecheck**

Run: `npm run lint`
Expected: no errors. Confirm `maxDuration = 60` on the webhook still covers the added Square round-trip (invoice sync fetches invoices + orders + catalog; it's the same work the manual button does within the request budget).

- [ ] **Step 4: Manual smoke test (cron path)**

Run `npm run dev`; invoke the cron locally:
Run: `curl -s -H "authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/finance-sync | head`
Expected: JSON including `invoiceLineSync` + `invoiceAutoMapped` counts, no error.

- [ ] **Step 5: Commit**

```bash
git add app/api/webhooks/square/route.ts app/api/cron/finance-sync/route.ts
git commit -m "feat(finance): sync + auto-map invoice line items on invoice webhook + cron"
```

---

## Task 8: Full verification + coverage floor

Confirm the whole suite passes, coverage stays above floor, and the app builds.

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite with coverage**

Run: `npm run test`
Expected: all tests PASS; coverage report shows `lib/` `lines` ≥ 86 and `statements` ≥ 86. If `autoMap.ts` IO wrappers drag `lines` below floor (they're not unit-tested), either (a) the pure resolvers' tests plus the extracted-from-existing-route wrappers should keep it above floor since the deleted route code was uncovered anyway, or (b) add focused tests for a resolver branch not yet covered. Do NOT lower the threshold.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: successful production build (all touched routes compile).

- [ ] **Step 4: Final commit (if any lint/coverage fixups)**

```bash
git add -A
git commit -m "test(finance): verify auto-mapping trigger suite passes + coverage floor"
```

---

## Post-Plan Hand-Off Checklist

- [ ] **Prod migration:** `supabase/migrations/20260727_bank_ledger_counterparty_key.sql` must be applied to prod MANUALLY by the user after a backup (per `feedback_prod_db_migration_authorization`). Bank-ledger ingest auto-map (Task 2) and `autoMapBankLedger` (Task 3) SELECT/UPSERT `counterparty_key`, so they require the column in prod before the Ramp webhook/cron next runs.
- [ ] **Webhook year assumption:** Task 7 syncs the current year on invoice webhook events; prior-year invoice edits self-heal via the daily cron. Note if a per-invoice or event-date-derived sync is wanted later.
- [ ] The manual "Auto-map all" buttons remain in the UI as a safety net; no UI change is in scope.

---

## Task 9: Per-invoice webhook sync (final-review fix for Important 1)

The final whole-branch review flagged that the Task 7 invoice webhook calls `syncSquareInvoicesForYear` on **every** `invoice.*` event, which paginates ALL Square invoices + a full year of orders + the catalog each time — unbounded growth, rate-limit/timeout risk during bursts. Fix: add a per-invoice Square sync and call it from the webhook instead of the full-year sync. The `finance-sync` cron keeps `syncSquareInvoicesForYear` (its once-a-day full-year backstop is intended and stays).

**Files:**
- Modify: `lib/square/orders.ts` — add `fetchSquareInvoiceById`.
- Modify: `lib/finance/syncSquareInvoices.ts` — extract a shared context builder + per-invoice upsert helper; add `syncSquareInvoiceById`.
- Modify: `app/api/webhooks/square/route.ts` — invoice branch calls `syncSquareInvoiceById` (not the full-year sync).

**Interfaces:**
- Produces: `fetchSquareInvoiceById(invoiceId: string): Promise<SquareInvoice | null>`; `syncSquareInvoiceById(supabase, squareInvoiceId: string): Promise<{ found: boolean; outcome: "synced" | "updated" | "skipped" | "not_found"; error?: string }>`.
- Consumes: existing `fetchOrdersByIds`, `fetchCatalogItems`, `squareGet`, `isSquareNotFound`, `autoMapInvoiceLineItems`.

- [ ] **Step 1: Add `fetchSquareInvoiceById` to `lib/square/orders.ts`**

Import `squareGet` and `isSquareNotFound` from `./client` (currently only `squarePost, squarePostAll, squareLocationId` are imported). Add:

```ts
/** Fetch one Square invoice by id (GET /invoices/{id}); null if not found. */
export async function fetchSquareInvoiceById(invoiceId: string): Promise<SquareInvoice | null> {
  try {
    const res = await squareGet<{ invoice?: SquareInvoice }>(`/invoices/${invoiceId}`);
    return res.invoice ?? null;
  } catch (err) {
    if (isSquareNotFound(err)) return null;
    throw err;
  }
}
```

- [ ] **Step 2: Refactor `syncSquareInvoices.ts` — extract the shared context + per-invoice helper**

In `lib/finance/syncSquareInvoices.ts`, extract two internal helpers WITHOUT changing behavior:

`buildInvoiceSyncContext(supabase, catalogItems)` — returns `{ partnerByCustomerId, kegIndex, canVariationOz, variationById }`, containing exactly the four indexes `syncSquareInvoicesForYear` builds today (§1 partners load, §3 kegIndex + canVariationOz from catalog, §4 variation deposit mappings). Type the return as an exported-or-local `InvoiceSyncContext` interface.

`upsertInvoiceWithLines(supabase, inv, order, ctx)` — the body of the current `for (const inv of squareInvoices)` loop (lines building `invoices` upsert + line items + delete-trailing), returning `{ outcome: "synced" | "updated" | "skipped"; error?: string }` (skipped when `!order`; synced/updated from `wasInserted`; error carries the message currently pushed to `errors`).

Then rewrite `syncSquareInvoicesForYear` to: fetch invoices/orders/catalog as today, `ctx = buildInvoiceSyncContext(supabase, catalogItems)`, loop `upsertInvoiceWithLines`, aggregating `synced/updated/skipped/errors` into the SAME `SyncSquareInvoicesResult`. The existing `resolveLineItemCoa` export and its tests must stay unchanged and green.

- [ ] **Step 3: Add `syncSquareInvoiceById`**

```ts
export async function syncSquareInvoiceById(
  supabase: SupabaseClient,
  squareInvoiceId: string,
): Promise<{ found: boolean; outcome: "synced" | "updated" | "skipped" | "not_found"; error?: string }> {
  const inv = await fetchSquareInvoiceById(squareInvoiceId);
  if (!inv) return { found: false, outcome: "not_found" };

  const [orders, catalogItems] = await Promise.all([
    inv.order_id ? fetchOrdersByIds([inv.order_id]) : Promise.resolve([]),
    fetchCatalogItems() as Promise<CatalogItem[]>,
  ]);
  const order = orders[0];
  if (!order) return { found: true, outcome: "skipped" };

  const ctx = await buildInvoiceSyncContext(supabase, catalogItems);
  const res = await upsertInvoiceWithLines(supabase, inv, order, ctx);
  return { found: true, outcome: res.outcome, error: res.error };
}
```

Add `fetchSquareInvoiceById`, `fetchOrdersByIds` to the imports from `@/lib/square/orders` (`fetchCatalogItems` is already imported).

- [ ] **Step 4: Point the webhook at the per-invoice sync**

In `app/api/webhooks/square/route.ts`, inside the `if (invoiceEvent)` block, replace the Task 7 line-item sync body:

```ts
        try {
          const syncResult = await syncSquareInvoiceById(supabase, invoiceId);
          const year = new Date().getFullYear();
          const mapResult = await autoMapInvoiceLineItems(supabase, { year });
          console.log("[square-webhook] invoice line-item sync", {
            invoiceId, outcome: syncResult.outcome, mapped: mapResult.mapped,
          });
        } catch (e) {
          console.error("[square-webhook] invoice line-item sync failed", e);
        }
```

Change the import from `syncSquareInvoicesForYear` to `syncSquareInvoiceById` (the cron still imports `syncSquareInvoicesForYear` — do not touch the cron). The year-scoped `autoMapInvoiceLineItems` is a Supabase-only pass (cheap, no Square) and stays for description-sibling coverage.

- [ ] **Step 5: Verify**

Run `npm run test` (842 pass; `resolveLineItemCoa` tests still green), `npm run lint` (0 errors), `npm run build` (Compiled successfully). No new unit test is required (the refactor is behavior-preserving over already-tested pure logic + IO extraction; the codebase does not unit-test the IO sync path).

- [ ] **Step 6: Commit**

```bash
git add lib/square/orders.ts lib/finance/syncSquareInvoices.ts app/api/webhooks/square/route.ts
git commit -m "perf(finance): per-invoice webhook sync instead of full-year resync"
```

---

## Self-Review

- **Spec coverage:** ✅ Orders (Task 3/4/5), Invoices (Task 3/4/5/7/9), Expenses (Task 3/4/6 — GL cascade pre-existing), Bank ledger (Task 1/2/3/6). Both triggers covered: ingest (Task 2 bank; Task 7 invoice; POS + expense pre-existing) and rule-mutation (Task 5 variations; Task 6 counterparty; GL pre-existing). Application-layer only, no DB trigger. ✅
- **Placeholders:** none — every code step shows real code; the two "confirm the field name" steps (5.2, 6.1) are verification-of-existing-code steps, not deferred implementation.
- **Type consistency:** wrapper names (`autoMapPosLineItems`, `autoMapInvoiceLineItems`, `autoMapExpenses`, `autoMapBankLedger`) and resolver names (`resolvePosBackfill`, `resolveInvoiceBackfill`, `resolveBankBackfill`) are used identically across the File Structure interface block and Tasks 3–7. `applyLineItemUpdates` signature matches all call sites. `counterparty_key` added consistently to `BankLedgerRecord`, the migration, and the bank auto-map queries.
