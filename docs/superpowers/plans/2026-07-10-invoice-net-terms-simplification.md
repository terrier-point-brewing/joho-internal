# Invoice Net Terms Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the due date of every deposit and export invoice equal to the draft date (today) plus a single configurable net-terms value per invoice type, with no per-partner overrides.

**Architecture:** Introduce one shared module (`lib/production/invoiceTerms.ts`) that reads the net-terms value from `system_settings` and computes due dates, then route all five current call sites through it. The Square helper takes an explicit `dueDate` instead of a day count, so there is one code path. Per-partner override columns are dropped and their UI/route plumbing removed.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase Postgres, Square API (raw fetch), Vitest.

## Global Constraints

- No business logic in `app/api/**` or components — shared logic lives in `lib/`. (CLAUDE.md)
- New/modified `lib/` modules ship with co-located `*.test.ts` covering pure logic. Don't drop coverage below the `vitest.config.ts` floor. (CLAUDE.md)
- No raw color utilities or hand-rolled primitives in UI; use token utilities + `app/components/ui/` primitives. (CLAUDE.md) — relevant only to the settings-copy task, which changes text only.
- Migrations are the source of truth for schema; add a new migration, never hand-edit an existing one. The implementer writes the migration file but does **NOT** apply it to the live prod DB — the orchestrator applies it manually after a backup. (CLAUDE.md + prod-migration-authorization rule)
- Net-terms default when the setting is unreadable: **30**.
- Due-date rule (verbatim): `dueDate = todayIso() + netTerms days`, recomputed on every generate/regenerate.
- Commit after every task. End commit messages with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.
- Verify with `npm run lint` and `npm run test` (and `npm run build` in the final task).

---

## File Structure

**Created:**
- `lib/production/invoiceTerms.ts` — net-terms lookup + date math (the one place).
- `lib/production/invoiceTerms.test.ts` — unit tests for the above.
- `supabase/migrations/20260727_drop_partner_net_terms.sql` — drops the two override columns.

**Modified:**
- `lib/square/square-invoices.ts` — export wrapper takes `dueDate`, not `dueDays`.
- `app/api/production/allocations/[id]/invoice/route.ts` — deposit flow uses shared module; anchor = today.
- `app/api/production/export/invoice/route.ts` — export flow uses shared module; persists `due_date`.
- `app/api/production/export/invoices/[id]/line-items/route.ts` — draft-edit flow uses shared module.
- `lib/production/exportInvoicePreview.ts` — drop net-terms/`dueDays` from the preview.
- `app/production/hooks/queries.ts` — drop `dueDays` from the preview hook's type.
- `app/production/components/PartnersTab.tsx` — remove the two net-terms fields.
- `app/api/partners/contract-brewing/route.ts` + `[id]/route.ts` — remove net-terms from POST/PATCH.
- `app/production/types.ts` — remove the two fields from `ContractBrewingPartner`.
- `app/production/components/ExportSettingsPanel.tsx` + `DepositSettingsPanel.tsx` — reword copy.

---

## Task 1: Shared `invoiceTerms` module

**Files:**
- Create: `lib/production/invoiceTerms.ts`
- Test: `lib/production/invoiceTerms.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type InvoiceKind = "deposit" | "export"`
  - `getNetTermsDays(supabase: SupabaseClient, kind: InvoiceKind): Promise<number>`
  - `todayIso(): string` — `YYYY-MM-DD`
  - `addDaysIso(isoDate: string, days: number): string` — `YYYY-MM-DD`, TZ-independent

- [ ] **Step 1: Write the failing test**

Create `lib/production/invoiceTerms.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getNetTermsDays, addDaysIso } from "./invoiceTerms";

/** Stub for supabase.from("system_settings").select("value").eq("key",…).single(). */
function settingsStub(result: { data: { value: number } | null; error: unknown }): SupabaseClient {
  return {
    from() {
      return {
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve(result),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

describe("getNetTermsDays", () => {
  it("returns the configured value when the setting exists", async () => {
    const days = await getNetTermsDays(settingsStub({ data: { value: 14 }, error: null }), "deposit");
    expect(days).toBe(14);
  });

  it("defaults to 30 when the setting row is missing", async () => {
    const days = await getNetTermsDays(settingsStub({ data: null, error: null }), "export");
    expect(days).toBe(30);
  });

  it("defaults to 30 when the query errors", async () => {
    const days = await getNetTermsDays(settingsStub({ data: null, error: { message: "boom" } }), "export");
    expect(days).toBe(30);
  });
});

describe("addDaysIso", () => {
  it("adds days within a month", () => {
    expect(addDaysIso("2026-07-10", 14)).toBe("2026-07-24");
  });

  it("rolls over a month boundary", () => {
    expect(addDaysIso("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("rolls over a year boundary", () => {
    expect(addDaysIso("2026-12-25", 10)).toBe("2027-01-04");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- invoiceTerms`
Expected: FAIL — `Cannot find module './invoiceTerms'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/production/invoiceTerms.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type InvoiceKind = "deposit" | "export";

const SETTINGS_KEY: Record<InvoiceKind, string> = {
  deposit: "deposit_invoice_due_days",
  export: "export_invoice_due_days",
};

/** Fallback when the setting row is missing or unreadable. */
const DEFAULT_NET_TERMS_DAYS = 30;

/**
 * The single configured net-terms value (in days) for the given invoice type,
 * read from system_settings. There is no per-partner override — this is the one
 * source of truth. Falls back to 30 when the row is missing or the read errors.
 */
export async function getNetTermsDays(
  supabase: SupabaseClient,
  kind: InvoiceKind,
): Promise<number> {
  const key = SETTINGS_KEY[kind];
  const { data, error } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", key)
    .single();
  if (error) {
    console.error(`[invoiceTerms] failed to read ${key}:`, error);
    return DEFAULT_NET_TERMS_DAYS;
  }
  const value = data?.value as number | null | undefined;
  return typeof value === "number" ? value : DEFAULT_NET_TERMS_DAYS;
}

/** Today's server date as YYYY-MM-DD (UTC), matching the app's other date stamps. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Adds `days` calendar days to an ISO date (YYYY-MM-DD) and returns YYYY-MM-DD.
 * Uses UTC component math so the result is timezone-independent.
 */
export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- invoiceTerms`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/production/invoiceTerms.ts lib/production/invoiceTerms.test.ts
git commit -m "feat(finance): shared invoice net-terms + due-date module

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Square helper takes an explicit due date

**Files:**
- Modify: `lib/square/square-invoices.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CreateExportInvoiceParams` now has `dueDate: string` (was `dueDays: number`). `createExportInvoice` and `createDepositInvoice` both flow an explicit `dueDate` into `createInvoice`.

- [ ] **Step 1: Change `CreateExportInvoiceParams`**

In `lib/square/square-invoices.ts`, replace the interface (currently lines ~50-55):

```ts
export interface CreateExportInvoiceParams {
  squareCustomerId: string;
  title: string;
  lineItems: InvoiceLineItemDraft[];
  dueDate: string;
}
```

- [ ] **Step 2: Delete the `addDays` helper**

Remove the `addDays` function (currently lines ~77-81):

```ts
function addDays(date: Date, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 3: Make `dueDate` the only due-date input in `createInvoice`**

In `CreateInvoiceCoreParams` (currently lines ~151-163), remove the `dueDays` field and its comment, and make `dueDate` required:

```ts
interface CreateInvoiceCoreParams {
  squareCustomerId: string;
  title: string;
  description?: string;
  lineItems: InvoiceLineItemDraft[];
  /** Due date for the invoice's BALANCE payment request (YYYY-MM-DD). */
  dueDate: string;
  /** Defaults to today (YYYY-MM-DD) if omitted. */
  serviceDate?: string;
  acceptedPaymentMethods?: { card: boolean; bank_account: boolean; cash_app_pay: boolean; buy_now_pay_later: boolean };
  metadataType: "allocation-deposit" | "export-invoice";
}
```

In the `createInvoice` body: update the destructure to drop `dueDays`, delete the guard line, and set `due_date: dueDate` directly.

Replace the destructure (currently line ~170):

```ts
  const { squareCustomerId, title, description, lineItems, dueDate, serviceDate, acceptedPaymentMethods, metadataType } = params;
```

Delete this line (currently ~226):

```ts
  if (dueDays == null && dueDate == null) throw new Error("createInvoice requires either dueDays or dueDate");
```

Change the payment request `due_date` (currently line ~241) from:

```ts
          due_date: dueDate ?? addDays(new Date(), dueDays!),
```

to:

```ts
          due_date: dueDate,
```

- [ ] **Step 4: Forward `dueDate` in `createExportInvoice`**

In `createExportInvoice` (currently lines ~302-315), change `dueDays: params.dueDays` to `dueDate: params.dueDate`:

```ts
export async function createExportInvoice(
  params: CreateExportInvoiceParams
): Promise<ExportInvoiceResult> {
  return createInvoice({
    squareCustomerId: params.squareCustomerId,
    title: params.title,
    lineItems: params.lineItems,
    dueDate: params.dueDate,
    acceptedPaymentMethods: { card: true, bank_account: true, cash_app_pay: false, buy_now_pay_later: false },
    metadataType: "export-invoice",
  });
}
```

(`createDepositInvoice` already passes `dueDate: params.dueDate` — leave it unchanged.)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors ONLY in the three call sites that still pass `dueDays` (`export/invoice/route.ts`, `export/invoices/[id]/line-items/route.ts`) — those are fixed in Tasks 4 and 5. No errors inside `square-invoices.ts` itself.

- [ ] **Step 6: Commit**

```bash
git add lib/square/square-invoices.ts
git commit -m "refactor(square): export invoice helper takes explicit dueDate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Deposit invoice route — anchor due date to today

**Files:**
- Modify: `app/api/production/allocations/[id]/invoice/route.ts`

**Interfaces:**
- Consumes: `getNetTermsDays`, `todayIso`, `addDaysIso` from `lib/production/invoiceTerms`.
- Produces: nothing new.

- [ ] **Step 1: Add the import**

At the top of the file, after the existing imports, add:

```ts
import { getNetTermsDays, addDaysIso, todayIso } from "@/lib/production/invoiceTerms";
```

- [ ] **Step 2: Drop the override column from the query and partner type**

In the `.select(...)` on `batch_allocations` (currently line ~89), change the joined partner columns from:

```ts
contract_brewing_partners(id, company_name, square_customer_id, deposit_net_terms_days),
```

to:

```ts
contract_brewing_partners(id, company_name, square_customer_id),
```

And the partner type cast (currently line ~101) from:

```ts
  const partner = allocation.contract_brewing_partners as { id: string; company_name: string; square_customer_id: string | null; deposit_net_terms_days: number | null } | null;
```

to:

```ts
  const partner = allocation.contract_brewing_partners as { id: string; company_name: string; square_customer_id: string | null } | null;
```

- [ ] **Step 3: Replace the due-date block**

Replace the whole override-resolution block (currently lines ~133-146):

```ts
    // Due date: per-partner override, else global default from system_settings.
    let dueDays = partner.deposit_net_terms_days;
    if (dueDays == null) {
      const { data: setting, error: settingErr } = await supabase
        .from("system_settings")
        .select("value")
        .eq("key", "deposit_invoice_due_days")
        .single();
      if (settingErr) console.error("[deposit-invoice] failed to fetch deposit_invoice_due_days setting:", settingErr);
      dueDays = (setting?.value as number) ?? 30;
    }

    const serviceDate = batch.planned_brew_date;
    const dueDate = addDaysIso(serviceDate, dueDays);
```

with:

```ts
    // Due date = the date this invoice is drafted (today) + the single configured
    // net-terms value. Service date is the same draft date, so both flows behave
    // identically and the ledger stays consistent (due_date = invoice_date + terms).
    const netTerms = await getNetTermsDays(supabase, "deposit");
    const draftDate = todayIso();
    const serviceDate = draftDate;
    const dueDate = addDaysIso(draftDate, netTerms);
```

(`serviceDate` still feeds `invoiceParams.serviceDate` and the ledger `invoiceDate` below — now both are today.)

- [ ] **Step 4: Delete the local `addDaysIso` helper**

Remove the local helper at the bottom of the file (currently lines ~427-431):

```ts
function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
```

(The shared one from `invoiceTerms` replaces it.)

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: no errors in this file. (`batch.planned_brew_date` is simply no longer read; leaving it in the select is harmless.)

- [ ] **Step 6: Commit**

```bash
git add app/api/production/allocations/[id]/invoice/route.ts
git commit -m "feat(finance): deposit invoice due date = draft date + net terms

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Export invoice route — shared terms + persist due_date

**Files:**
- Modify: `app/api/production/export/invoice/route.ts`

**Interfaces:**
- Consumes: `getNetTermsDays`, `todayIso`, `addDaysIso`; `createExportInvoice({ …, dueDate })`.
- Produces: nothing new.

- [ ] **Step 1: Add the import**

After the existing imports, add:

```ts
import { getNetTermsDays, addDaysIso, todayIso } from "@/lib/production/invoiceTerms";
```

- [ ] **Step 2: Drop the override column from the partner select**

In the `generate` branch, change the partner `.select(...)` (currently line ~72) from:

```ts
      .select("company_name, square_customer_id, export_net_terms_days")
```

to:

```ts
      .select("company_name, square_customer_id")
```

- [ ] **Step 3: Replace the due-days resolution with the shared getter**

Replace this block (currently lines ~81-90):

```ts
    let dueDays = partner.export_net_terms_days as number | null;
    if (dueDays == null) {
      const { data: setting, error: settingErr } = await supabase
        .from("system_settings")
        .select("value")
        .eq("key", "export_invoice_due_days")
        .single();
      if (settingErr) console.error("[export-invoice] failed to fetch export_invoice_due_days setting:", settingErr);
      dueDays = (setting?.value as number) ?? 30;
    }
```

with:

```ts
    const netTerms = await getNetTermsDays(supabase, "export");
    const draftDate = todayIso();
    const dueDate = addDaysIso(draftDate, netTerms);
```

- [ ] **Step 4: Pass `dueDate` to Square**

In the `createExportInvoice({...})` call (currently lines ~94-99), change `dueDays,` to `dueDate,`:

```ts
      result = await createExportInvoice({
        squareCustomerId: partner.square_customer_id,
        title: `Export Invoice — ${partner.company_name}`,
        lineItems,
        dueDate,
      });
```

- [ ] **Step 5: Persist `due_date` and use the draft date on the ledger row**

Remove the now-redundant `today` line (currently line ~105):

```ts
    const today = new Date().toISOString().slice(0, 10);
```

In the `invoices` upsert object (currently lines ~112-125), change `invoice_date: today` to `invoice_date: draftDate` and add `due_date: dueDate`:

```ts
          source: "square",
          external_id: result.invoiceId,
          square_invoice_id: result.invoiceId,
          invoice_number: result.invoiceNumber ?? null,
          invoice_type: "export_invoice",
          partner_id: customerId,
          customer_name: partner.company_name,
          invoice_date: draftDate,
          due_date: dueDate,
          status: "draft",
          subtotal_cents: totalCents,
          tax_cents: 0,
          total_cents: totalCents,
```

- [ ] **Step 6: Typecheck + lint**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: no errors in this file.

- [ ] **Step 7: Commit**

```bash
git add app/api/production/export/invoice/route.ts
git commit -m "feat(finance): export invoice due date = draft date + net terms, persisted

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Export line-items (draft edit) route — shared terms

**Files:**
- Modify: `app/api/production/export/invoices/[id]/line-items/route.ts`

**Interfaces:**
- Consumes: `getNetTermsDays`, `todayIso`, `addDaysIso`; `createExportInvoice({ …, dueDate })`.
- Produces: nothing new.

- [ ] **Step 1: Add the import**

After the existing imports, add:

```ts
import { getNetTermsDays, addDaysIso, todayIso } from "@/lib/production/invoiceTerms";
```

- [ ] **Step 2: Drop the override column from the partner select**

Change the partner `.select(...)` (currently line ~71) from:

```ts
    .select("company_name, square_customer_id, export_net_terms_days")
```

to:

```ts
    .select("company_name, square_customer_id")
```

- [ ] **Step 3: Replace the due-days resolution**

Replace this block (currently lines ~78-86):

```ts
  let dueDays = partner.export_net_terms_days as number | null;
  if (dueDays == null) {
    const { data: setting } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "export_invoice_due_days")
      .single();
    dueDays = (setting?.value as number) ?? 30;
  }
```

with:

```ts
  // Editing line items recreates the Square draft, so the due date re-derives
  // from today (a redraft resets the clock).
  const netTerms = await getNetTermsDays(supabase, "export");
  const draftDate = todayIso();
  const dueDate = addDaysIso(draftDate, netTerms);
```

- [ ] **Step 4: Pass `dueDate` to Square**

In the `createExportInvoice({...})` call (currently lines ~169-174), change `dueDays,` to `dueDate,`:

```ts
    newSquareResult = await createExportInvoice({
      squareCustomerId: partner.square_customer_id,
      title: `Export Invoice — ${partner.company_name}`,
      lineItems: lineItemsForSquare,
      dueDate,
    });
```

- [ ] **Step 5: Keep the ledger row consistent with the recreated draft**

In the `invoices` update after recreation (currently lines ~191-199), add `invoice_date` and `due_date` so the ledger matches the new Square draft:

```ts
  const { error: invUpdateErr } = await supabase
    .from("invoices")
    .update({
      square_invoice_id: newSquareResult.invoiceId,
      external_id: newSquareResult.invoiceId,
      subtotal_cents: newTotal,
      total_cents: newTotal,
      invoice_date: draftDate,
      due_date: dueDate,
    })
    .eq("id", invoiceId);
```

- [ ] **Step 6: Typecheck + lint**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: no errors. (After this task, `tsc` should be fully clean — all `dueDays` call sites are gone.)

- [ ] **Step 7: Commit**

```bash
git add app/api/production/export/invoices/[id]/line-items/route.ts
git commit -m "feat(finance): draft line-item edits re-derive due date from today

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Remove net terms from the export preview

**Files:**
- Modify: `lib/production/exportInvoicePreview.ts`
- Modify: `app/production/hooks/queries.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `InvoicePreviewResult` no longer has a `dueDays` field.

- [ ] **Step 1: Remove `dueDays` from `InvoicePreviewResult`**

In `lib/production/exportInvoicePreview.ts`, delete the `dueDays: number;` line from the `InvoicePreviewResult` interface (currently line ~23).

- [ ] **Step 2: Remove the `DEFAULT_DUE_DAYS` constant**

Delete (currently line ~48):

```ts
const DEFAULT_DUE_DAYS = 30;
```

- [ ] **Step 3: Drop the override column from the partner select**

Change the partner `.select(...)` (currently line ~205) from:

```ts
    .select("id, company_name, square_customer_id, export_net_terms_days")
```

to:

```ts
    .select("id, company_name, square_customer_id")
```

- [ ] **Step 4: Remove the due-days resolution block**

Delete this block entirely (currently lines ~210-218):

```ts
  let dueDays = partner.export_net_terms_days as number | null;
  if (dueDays == null) {
    const { data: setting } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "export_invoice_due_days")
      .single();
    dueDays = (setting?.value as number) ?? DEFAULT_DUE_DAYS;
  }
```

- [ ] **Step 5: Remove `dueDays` from the returned object**

In the final `return { ... }` of `buildInvoicePreview` (currently ~line 384), delete the `dueDays,` line.

- [ ] **Step 6: Drop `dueDays` from the preview hook type**

In `app/production/hooks/queries.ts`, inside `useInvoicePreview` (currently line ~247), delete the `dueDays: number;` line from the inline response type.

- [ ] **Step 7: Typecheck + test**

Run: `npx tsc --noEmit` then `npm run test -- exportInvoicePreview`
Expected: no type errors; the existing preview tests still pass (they don't reference `dueDays`).

- [ ] **Step 8: Commit**

```bash
git add lib/production/exportInvoicePreview.ts app/production/hooks/queries.ts
git commit -m "refactor(finance): drop unused net-terms from export invoice preview

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Remove per-partner override plumbing

**Files:**
- Modify: `app/production/components/PartnersTab.tsx`
- Modify: `app/api/partners/contract-brewing/route.ts`
- Modify: `app/api/partners/contract-brewing/[id]/route.ts`
- Modify: `app/production/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ContractBrewingPartner` no longer has `export_net_terms_days` / `deposit_net_terms_days`.

- [ ] **Step 1: PartnersTab — remove from `PARTNER_EMPTY`**

In `app/production/components/PartnersTab.tsx`, delete these two lines from `PARTNER_EMPTY` (currently lines ~20-21):

```ts
  export_net_terms_days: "",
  deposit_net_terms_days: "",
```

- [ ] **Step 2: PartnersTab — remove from `openEdit`**

Delete these two lines from the `setForm({...})` in `openEdit` (currently lines ~249-250):

```ts
      export_net_terms_days: "export_net_terms_days" in p && p.export_net_terms_days != null ? String(p.export_net_terms_days) : "",
      deposit_net_terms_days: "deposit_net_terms_days" in p && p.deposit_net_terms_days != null ? String(p.deposit_net_terms_days) : "",
```

- [ ] **Step 3: PartnersTab — remove from the submit payload**

Delete these two lines from the `payload` object in `handleSubmit` (currently lines ~269-270):

```ts
        ...(kind === "contract" ? { export_net_terms_days: form.export_net_terms_days ? Number(form.export_net_terms_days) : null } : {}),
        ...(kind === "contract" ? { deposit_net_terms_days: form.deposit_net_terms_days ? Number(form.deposit_net_terms_days) : null } : {}),
```

- [ ] **Step 4: PartnersTab — remove the two `<Field>` inputs**

Delete both net-terms field blocks from the modal form (currently lines ~473-484):

```tsx
            {kind === "contract" && (
              <Field label="Export Net Terms (days)" hint="Leave blank to use the global default">
                <input type="number" min={1} max={365} className="inp" value={form.export_net_terms_days}
                  onChange={(e) => setForm((f) => ({ ...f, export_net_terms_days: e.target.value }))} />
              </Field>
            )}
            {kind === "contract" && (
              <Field label="Deposit Net Terms (days)" hint="Leave blank to use the global default">
                <input type="number" min={1} max={365} className="inp" value={form.deposit_net_terms_days}
                  onChange={(e) => setForm((f) => ({ ...f, deposit_net_terms_days: e.target.value }))} />
              </Field>
            )}
```

- [ ] **Step 5: POST route — remove from destructure + insert**

In `app/api/partners/contract-brewing/route.ts`, change the destructure (currently line ~25) from:

```ts
  const { company_name, first_name, last_name, phone, address, email, notes, export_net_terms_days, deposit_net_terms_days } = body;
```

to:

```ts
  const { company_name, first_name, last_name, phone, address, email, notes } = body;
```

And delete these two lines from the `.insert({...})` (currently lines ~38-39):

```ts
      export_net_terms_days: export_net_terms_days != null ? Number(export_net_terms_days) : null,
      deposit_net_terms_days: deposit_net_terms_days != null ? Number(deposit_net_terms_days) : null,
```

- [ ] **Step 6: PATCH route — remove from destructure + update**

In `app/api/partners/contract-brewing/[id]/route.ts`, change the destructure (currently line ~14) from:

```ts
  const { company_name, first_name, last_name, phone, address, email, notes, square_customer_id, export_net_terms_days, deposit_net_terms_days } = await req.json();
```

to:

```ts
  const { company_name, first_name, last_name, phone, address, email, notes, square_customer_id } = await req.json();
```

And delete these two lines from the `.update({...})` (currently lines ~28-29):

```ts
      ...(export_net_terms_days !== undefined ? { export_net_terms_days: export_net_terms_days != null ? Number(export_net_terms_days) : null } : {}),
      ...(deposit_net_terms_days !== undefined ? { deposit_net_terms_days: deposit_net_terms_days != null ? Number(deposit_net_terms_days) : null } : {}),
```

- [ ] **Step 7: types.ts — remove the two fields**

In `app/production/types.ts`, delete these two lines from the `ContractBrewingPartner` interface (currently lines ~510-511):

```ts
  export_net_terms_days: number | null;
  deposit_net_terms_days: number | null;
```

- [ ] **Step 8: Typecheck + lint**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: no errors. Confirm no remaining references:
Run: `grep -rn "net_terms_days" app lib` → expect **no matches**.

- [ ] **Step 9: Commit**

```bash
git add app/production/components/PartnersTab.tsx app/api/partners/contract-brewing/route.ts app/api/partners/contract-brewing/[id]/route.ts app/production/types.ts
git commit -m "refactor(finance): remove per-partner net-terms overrides

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Reword the Settings copy

**Files:**
- Modify: `app/production/components/ExportSettingsPanel.tsx`
- Modify: `app/production/components/DepositSettingsPanel.tsx`

**Interfaces:**
- Consumes: nothing. Text-only change.
- Produces: nothing.

- [ ] **Step 1: Export settings copy**

In `app/production/components/ExportSettingsPanel.tsx`, in `InvoiceTermsSection` (currently lines ~707-710), replace the heading and description:

```tsx
      <h3 className="text-sm font-medium text-strong mb-2">Export Invoice Net Terms</h3>
      <p className="text-xs text-faint mb-2">
        Days from the draft date until an export invoice is due. Applies to every partner.
      </p>
```

- [ ] **Step 2: Deposit settings copy**

In `app/production/components/DepositSettingsPanel.tsx`, in `DepositInvoiceTermsSection` (currently lines ~105-108), replace the heading and description:

```tsx
      <h3 className="text-sm font-medium text-strong mb-2">Deposit Invoice Net Terms</h3>
      <p className="text-xs text-faint mb-2">
        Days from the draft date until a deposit invoice is due. Applies to every partner.
      </p>
```

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/production/components/ExportSettingsPanel.tsx app/production/components/DepositSettingsPanel.tsx
git commit -m "chore(finance): reword net-terms settings copy (single value, no overrides)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Migration to drop the override columns

**Files:**
- Create: `supabase/migrations/20260727_drop_partner_net_terms.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: schema without the two override columns. **NOT applied to prod by the implementer.**

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260727_drop_partner_net_terms.sql`:

```sql
-- Drop per-partner invoice net-terms overrides.
--
-- Net terms are now a single configured value per invoice type, stored in
-- system_settings (deposit_invoice_due_days / export_invoice_due_days) and
-- edited from Production → Settings. The per-partner override columns are no
-- longer read by any code path.
--
-- Apply ONLY after the code that stops selecting these columns has deployed.
alter table public.contract_brewing_partners
  drop column if exists export_net_terms_days,
  drop column if exists deposit_net_terms_days;
```

- [ ] **Step 2: Verify the SQL parses (dry check)**

Run: `grep -c "drop column if exists" supabase/migrations/20260727_drop_partner_net_terms.sql`
Expected: `2`. (Do not apply to prod — the orchestrator applies it manually after a backup, once the code has deployed.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260727_drop_partner_net_terms.sql
git commit -m "feat(db): migration to drop per-partner net-terms columns

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 2: Tests**

Run: `npm run test`
Expected: all pass, including the new `invoiceTerms` suite.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles clean (no type errors).

- [ ] **Step 4: Grep for leftovers**

Run: `grep -rn "net_terms_days\|dueDays\|DEFAULT_DUE_DAYS" app lib | grep -v payroll`
Expected: **no matches** (payroll's own `dueDays` is unrelated and excluded).

- [ ] **Step 5: Final confirmation**

Confirm the working tree is clean (`git status`) and all tasks are committed. Report the branch is ready for review and note that the prod migration (`20260727_drop_partner_net_terms.sql`) still needs manual application after the code deploys.

---

## Self-Review

**Spec coverage:**
- Single value per type, no overrides → Tasks 1, 7, 9. ✅
- Configured only from Production → Settings → Task 8 (copy), settings routes unchanged. ✅
- Due date = draft date + net terms, both flows → Tasks 3, 4, 5. ✅
- Persist `due_date` in export ledger (current gap) → Task 4 Step 5, Task 5 Step 5. ✅
- Deposit service date + `invoice_date` become today → Task 3 Step 3. ✅
- Shared module kills 5-way duplication → Tasks 1–6. ✅
- Drop preview `dueDays` (dead) → Task 6. ✅
- Migration written but not applied → Task 9. ✅

**Placeholder scan:** No TBD/TODO; every code step shows exact code. ✅

**Type consistency:** `getNetTermsDays(supabase, kind)`, `todayIso()`, `addDaysIso(iso, days)`, and `CreateExportInvoiceParams.dueDate: string` are used identically across Tasks 2–6. ✅
