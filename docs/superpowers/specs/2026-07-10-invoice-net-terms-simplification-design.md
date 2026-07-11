# Invoice Net Terms Simplification — Design

**Date:** 2026-07-10
**Status:** Approved (pending spec review)

## Goal

Make the net-terms / due-date logic for deposit and export invoices dead simple
and obvious:

> **The due date for a deposit or export invoice is the date it is drafted
> (today) plus the configured net-terms days.**

Remove all per-partner override machinery. Net terms are configured in exactly
one place per invoice type — **Production → Settings** — as a single value each.

## Motivation

The current logic has three problems:

1. **Two different anchor dates.** Deposit due dates counted from
   `planned_brew_date`; export due dates counted from "today at generation."
   Same concept, two behaviors.
2. **Per-partner overrides that can't be edited.** Net terms had a per-partner
   override (`contract_brewing_partners.{deposit,export}_net_terms_days`), but
   the only UI to set them — the Partners tab edit modal — disables its "Edit"
   button for any Square-linked partner. Since a partner *must* be Square-linked
   to be invoiced, the override was unreachable for every partner that could
   actually use it.
3. **Resolution logic copy-pasted in five places** (deposit route, export
   route, export line-items route, export preview, plus the two hardcoded `?? 30`
   fallbacks), each fetching the same `system_settings` key independently.

## The rule (both flows)

```
draftDate = today (server date at generation time, YYYY-MM-DD)
netTerms  = system_settings[<kind>_invoice_due_days]   // default 30
dueDate   = draftDate + netTerms days
```

- Computed fresh on **every** generate / regenerate / revise. A revision resets
  the clock — "first drafted date" effectively means "this draft's date."
  (Explicitly chosen over pinning to the original draft.)
- `dueDate` is persisted to `invoices.due_date` in **both** flows and sent to
  Square as an explicit `due_date`.
- Both flows also set the Square `sale_or_service_date` and the ledger
  `invoice_date` to `draftDate` (today), so the ledger is self-consistent:
  `due_date = invoice_date + netTerms`. This changes the deposit flow, which
  previously used `planned_brew_date` for both — see Decisions.

## Data model changes

**Migration** `supabase/migrations/<ts>_drop_partner_net_terms.sql`:

```sql
alter table public.contract_brewing_partners
  drop column if exists export_net_terms_days,
  drop column if exists deposit_net_terms_days;
```

- The two `system_settings` keys — `deposit_invoice_due_days` and
  `export_invoice_due_days` — are **kept**. They become the single source of
  truth for each invoice type (no longer "the default when no override exists").
- Deposit and export remain **separately** configurable (two keys, two settings
  inputs). "A single configurable value" is read as "one value per type, no
  per-partner dimension," not "one shared value for both."
- Per our standing rule, the migration file is written but **not** applied to
  prod by the implementer; it is applied manually after a backup.

## New shared module

`lib/production/invoiceTerms.ts` (with co-located `invoiceTerms.test.ts`):

```ts
export type InvoiceKind = "deposit" | "export";

/** Reads the single net-terms value for the given invoice type from
 *  system_settings. Defaults to 30 when unset or unreadable. */
export async function getNetTermsDays(
  supabase: SupabaseClient,
  kind: InvoiceKind,
): Promise<number>;

/** Adds `days` calendar days to an ISO (YYYY-MM-DD) date, returning ISO. */
export function addDaysIso(isoDate: string, days: number): string;

/** Today's date as YYYY-MM-DD (server local). */
export function todayIso(): string;
```

This replaces the resolution logic in all five call sites and consolidates the
two existing `addDays`/`addDaysIso` helpers (in the deposit route and in
`square-invoices.ts`) into one.

Tests cover: default-30 when the key is missing, reading a configured value, and
`addDaysIso` calendar math (including month rollover).

## Per-file changes

### `lib/square/square-invoices.ts`
- `CreateExportInvoiceParams`: replace `dueDays: number` with `dueDate: string`.
- `CreateInvoiceCoreParams`: remove `dueDays`; make `dueDate` required.
- `createInvoice`: `due_date: dueDate` directly. Delete the
  `dueDays == null && dueDate == null` guard and the `addDays` helper (now
  unused — the only consumer was the `dueDays` branch).
- `createExportInvoice`: forward `dueDate`.
- `createDepositInvoice` already takes `dueDate` — unchanged, but see the
  deposit route for how `serviceDate` is now computed.

### `app/api/production/allocations/[id]/invoice/route.ts` (deposit)
- Remove `deposit_net_terms_days` from the `contract_brewing_partners` select
  and the partner type.
- Replace the override-resolution block with
  `const netTerms = await getNetTermsDays(supabase, "deposit")`.
- `const draftDate = todayIso();`
  `const serviceDate = draftDate;`  // was `batch.planned_brew_date`
  `const dueDate = addDaysIso(draftDate, netTerms);`
- Ledger `invoiceDate` = `draftDate` (was `serviceDate`/brew date).
- Delete the local `addDaysIso` helper (moved to the shared module).

### `app/api/production/export/invoice/route.ts`
- Remove `export_net_terms_days` from the select.
- `const netTerms = await getNetTermsDays(supabase, "export")`;
  `const draftDate = todayIso()`; `const dueDate = addDaysIso(draftDate, netTerms)`.
- Pass `dueDate` to `createExportInvoice`.
- **Add** `due_date: dueDate` to the `invoices` upsert (currently omitted), and
  set `invoice_date: draftDate` (already `today`).

### `app/api/production/export/invoices/[id]/line-items/route.ts`
- Same resolution swap; compute `dueDate` and pass it to `createExportInvoice`.
- (This path recreates the Square draft on every line-item edit, so the due date
  re-derives from the edit date — consistent with "reset on redraft.")

### `lib/production/exportInvoicePreview.ts`
- Remove `export_net_terms_days` from the partner select and the override block;
  the preview no longer needs net terms at all.
- Drop the `dueDays` field from `InvoicePreviewResult` and `DEFAULT_DUE_DAYS`
  (no UI consumer reads `preview.dueDays`). Update
  `exportInvoicePreview.test.ts` if it asserts on the field.

### `app/production/components/PartnersTab.tsx`
- Remove `export_net_terms_days` / `deposit_net_terms_days` from `PARTNER_EMPTY`,
  `openEdit`, and the `handleSubmit` payload.
- Remove the two "Net Terms (days)" `<Field>` inputs.
- (The Square-linked "Edit"-disabled behavior is untouched; it no longer hides
  anything the user needs, since terms moved to Settings.)

### `app/api/partners/contract-brewing/route.ts` + `[id]/route.ts`
- Remove `export_net_terms_days` / `deposit_net_terms_days` from the POST insert
  and the PATCH update.

### `app/production/types.ts`
- Remove the two fields from the `ContractBrewingPartner` interface.

### `ExportSettingsPanel.tsx` / `DepositSettingsPanel.tsx`
- Reword the section copy: these are now *the* net terms, not a default. Drop
  "used when a partner has no override set" and "set per-partner in the Partners
  tab."
- The settings API routes (`export-settings/invoice-due-days`,
  `deposit-settings/invoice-due-days`) are unchanged — they already read/write
  the single `system_settings` key.

## Decisions

1. **Revision anchor:** reset to the latest draft date (not pinned to the
   original). Simpler; no carry-forward state.
2. **Deposit service date:** becomes today (the draft date), matching export.
   The deposit invoice's Square `sale_or_service_date` and ledger `invoice_date`
   no longer use `planned_brew_date`. Fully uniform across both flows.
3. **Two values, not one:** deposit and export keep independent configurable
   values.

## Out of scope

- The per-partner override for **Square catalog item mappings** (Ingredient
  Deposit item, packaging fees, service mappings) is unrelated to net terms and
  is left exactly as-is, including `PartnerOverridePicker`.
- The payroll `due_date_days_after_end` logic is a separate concept and is not
  touched.

## Testing

- `lib/production/invoiceTerms.test.ts` — new, covers `getNetTermsDays` default +
  configured, and `addDaysIso`.
- Update `lib/production/exportInvoicePreview.test.ts` for the removed `dueDays`.
- `npm run lint` + `npm run test` green; `npm run build` clean.
