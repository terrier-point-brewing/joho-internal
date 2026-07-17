# Wake County — Prepared Food & Beverage Tax (Tax Party #3) — Design

**Date:** 2026-07-17
**Status:** Approved (design), pending spec review
**Author:** Finance / Tax module

## Goal

Add a third tax-filing module — **Wake County — Prepared Food & Beverage Tax** —
to Finance → Taxes, alongside the existing **NC DOR — Sales & Use Tax** and
**NC DOR — Beer Excise Tax (B-C-710)**. Wake County levies a **1%** tax on the
sale price of prepared food and beverages sold at retail (effective 1993),
collected by the merchant in addition to NC state sales tax and remitted to the
county **monthly**.

The module presents three figures per filing period:

1. **Gross Receipts** — Taproom Net Sales, computed with the *same logic* as
   NC DOR Sales & Use Tax (the general-sales-tax taxable base).
2. **Applicable Gross Receipts** — the Net Sales attributed to items that carry
   the Prepared Food & Beverage Tax, so the user can see the difference.
3. **Tax Owed** — Applicable Gross Receipts × 1%.

## Architecture

This is a **pure plugin addition** to the existing party-template registry —
the exact same pattern by which Beer Excise (party #2) was added. No changes to
the generic tax core (schedules, tasks, worksheet shell, settings pages, API
routes, cron) are required; all of those are already generic over the party
registry (`lib/tax/registry.ts` server-side, `app/finance/tax/parties/registry.ts`
client-side) and pick up a new party automatically once it registers.

The one deliberate, low-risk refactor: the Square-tax-line base fetcher
(`fetchTaxableBase`) currently lives *inside* `lib/tax/parties/ncDorSalesUse/calc.ts`.
Wake County needs the identical query, so it is **extracted** to a shared
`lib/tax/squareTaxBase.ts` module and imported by both parties — reuse over
duplication, and it avoids one party importing across a sibling party's
internals.

### Confirmed facts (verified against the live database, 2026-07-17)

- Square already tracks this tax as a distinct catalog tax line:
  `square_tax_id = "ARI25PLSGLDVIBUQITKTRNSX"`, name `"Prepared Food & Beverage Tax"`,
  separate from `"General Sales Tax"` (`ADD7EKQD2KN72NOYVUWHU34J`). Both feed the
  synced `pos_line_item_taxes` table, so the same join pattern Sales & Use uses
  applies directly.
- There is **no** `wake_county` authority yet (current authorities: `nc_dor`,
  `federal_ttb`, `irs`, `nc_abc`) — this design adds one.
- `tax_rates.category` has **no** DB check constraint, so a new category value is
  a data-only change (no constraint migration). Only `lib/production/exciseTax.ts`
  filters rates by category (`excise`); the tax rate map is otherwise keyed purely
  by `key`, so a new category is cosmetic/semantic.

## Data Model Changes

One human-gated migration: `supabase/migrations/20260803_wake_county_food_beverage_tax.sql`

1. **New authority** in `tax_authorities`:
   `('wake_county', 'Wake County Department of Tax Administration', 4)`
2. **New rate** in `tax_rates`:
   `key = 'wake_county_food_beverage_tax'`, `name = 'Wake County Prepared Food & Beverage Tax'`,
   `category = 'prepared_food'`, `party_key = 'wake_county'`, `basis = 'percent'`,
   `rate = 0.01`, `is_active = true`.

No `tax_registrations` rows are seeded — the Wake County Gross Receipts Account #
is real business data the user enters through the existing Tax Profile →
Registrations UI (the template declares it as a `requiredRegistration`, which the
IdentityHeader surfaces automatically).

The `TaxRate.category` union type in `lib/tax/rates.ts` gains `"prepared_food"`.

## Calculation

New party module: `lib/tax/parties/wakeCountyFoodBeverage/`

### Two Square tax-line settings (self-contained, no cross-party reads)

Declared in the template's `settingsSchema` (rendered automatically by the
existing generic `IdentityForm` on Finance → Settings → Tax Filing — both
optionless `select` fields receive the live Square catalog-tax option list):

- `food_beverage_tax_id` — **required** `select`. The Square catalog tax
  representing the Wake County Prepared Food & Beverage Tax. Drives Applicable
  Gross Receipts and Tax Owed.
- `general_sales_tax_id` — **optional** `select`. The Square general-sales tax,
  used only to compute the Gross Receipts comparison row. If unset, the Gross
  Receipts row displays "—" (no config duplication is forced on the user, since
  they already set this on Sales & Use).
- `filing_pin` — `text`, `sensitive: true`. The 4-digit Wake County e-filing PIN.
  `type: "text"` preserves a leading zero; `sensitive: true` means the existing
  `maskSensitive` (`lib/tax/profiles.ts`) never returns it to the browser in the
  clear (rendered as a masked password input with present/absent status), the
  same treatment as SSN/FEIN.

### Figures (`computeWakeWorksheet`)

Reusing the shared `fetchTaxableBase(sb, squareTaxId, period)` → `{ baseCents, collectedCents }`:

- **Gross Receipts** = `fetchTaxableBase(general_sales_tax_id).baseCents`
  (only if `general_sales_tax_id` is configured; else null/omitted).
  Where each line's base = `net_sales_cents − tax_cents` (post-discount, pre-tax),
  identical to Sales & Use's Line 1.
- **Applicable Gross Receipts** = `fetchTaxableBase(food_beverage_tax_id).baseCents`.
- **Collected F&B tax** = `fetchTaxableBase(food_beverage_tax_id).collectedCents`
  (Square-collected amount, for reconciliation only).
- **Rate** = the active `wake_county_food_beverage_tax` rate from `tax_rates`
  (via `getTaxRate`), falling back to the statutory `0.01` constant if the row is
  missing.
- **Tax Owed** = `Math.round(applicableBaseCents × rate)`.

### Reconciliation warning (F&B line only)

Mirrors the Sales & Use / Beer Excise tolerance pattern: if
`|taxOwed − collectedFbCents| > max(100¢, round(collectedFbCents × 0.001))`,
push a warning ("Computed Wake County tax (…¢) differs from Square-collected
(…¢) by …¢, exceeding the …¢ rounding tolerance. Review before filing.").
Gross Receipts is display-only and is **not** reconciled.

### Worksheet fields (all computed — no manual inputs)

```
wake_gross_receipts_cents        // number | null (null if general tax id unset)
wake_applicable_receipts_cents   // number
wake_tax_owed_cents              // number
wake_collected_fb_cents          // number (for the reconciliation warning)
wake_rate                        // number (the rate applied, for display/audit)
```

Per the explicit scope, the worksheet shows only the three figures the user
asked for; there are **no** manual penalty/interest/discount lines. Because
every field is computed, `fieldOwnership` marks all keys `"computed"` and
`mergeWorksheet` returns the recomputed field set directly (nothing manual to
preserve). If real filings later need penalty/interest, that is an additive
follow-up that would introduce a `derive.ts` + client-math wrapper following the
Beer Excise pattern — out of scope here.

## Filing Credentials

Item 1 of the requirements (Contact Name, Email, Telephone #, Wake County Gross
Receipts Account #, 4-digit PIN) maps onto the existing shared identity system —
all surfaced by `TaxWorksheetShell`'s `IdentityHeader` above the worksheet:

- **Contact Name / Email / Telephone #** — reuse the shared **Legal
  Representative** (`tax_legal_representative`: name/phone/email), the same
  contact used by Sales & Use and Beer Excise. No new fields.
- **Wake County Gross Receipts Account #** — a new `tax_registrations` entry
  under the `wake_county` authority, declared in the template's
  `requiredRegistrations` as
  `{ authorityKey: "wake_county", registrationKey: "wake_county_account_id", label: "Wake County Gross Receipts Account Number" }`.
  The user enters the value via Tax Profile → Registrations.
- **4-digit PIN** — the `filing_pin` sensitive settings field described above.

Like the other two parties, this module **prepares and records** the filing
(worksheet + confirmation capture via the existing `CompletePanel` /
`tax-confirmations` Storage flow); it does **not** transmit to Wake County. The
credential fields are displayed so the user has them to hand for the county
portal.

## Schedule / Period

- **Monthly only** (`supportedFrequencies: ["monthly"]`) — Wake County remits
  monthly.
- **Period** = calendar month.
- **Due date** = the **20th of the following month** (`{ monthOffset: 1, day: 20 }`),
  matching NC DOR Sales & Use and Wake County's published ordinance.
- No schedule config (single county, single rate) → `scheduleConfigSchema: []`.

## UI

- **New worksheet component**: `app/finance/tax/parties/WakeCountyFoodBeverage/Worksheet.tsx`
  — a read-only three-row display (Gross Receipts / Applicable Gross Receipts /
  Tax Owed), using existing token utilities and the same table/typography
  conventions as the Beer Excise worksheet. Money rendered `text-sm font-mono
  tabular-nums` via `fmtCents`. Gross Receipts shows "—" when null.
- **Client field-ownership + total accessor**:
  `app/finance/tax/parties/WakeCountyFoodBeverage/fieldOwnership.ts` — thin
  re-export of the pure lib resolver plus `getTotalDueCents` (reads
  `wake_tax_owed_cents`).
- **Client registry**: one new entry in
  `app/finance/tax/parties/registry.ts`'s `WORKSHEET_MODULES`
  (`wake_county_food_beverage`).
- **Everything else is automatic**: the Tax tab, Schedule editor (party dropdown),
  Tax Filing settings pane (Square mappings + reference table + PIN), completion
  flow, and cron all read the registry and require **zero** changes.

All UI follows `docs/UI_STANDARD.md`: token utilities only (no raw colors),
`.inp`/`.btn-*` primitives, shared `Card`/`Banner`/`PageHeader`/`Modal`, the type
and spacing scales.

## File Structure

**Migration (human-gated):**
- `supabase/migrations/20260803_wake_county_food_beverage_tax.sql` — authority +
  rate seed.

**Shared extraction:**
- `lib/tax/squareTaxBase.ts` (new) — `fetchTaxableBase` moved here, unchanged
  behavior. + `lib/tax/squareTaxBase.test.ts`.
- `lib/tax/parties/ncDorSalesUse/calc.ts` (modify) — import `fetchTaxableBase`
  from the shared module; keep the existing re-export so current import sites and
  tests are unaffected.

**New party (`lib/tax/parties/wakeCountyFoodBeverage/`):**
- `rates.ts` — `WAKE_FB_RATE_KEY`, `WAKE_FB_RATE_FALLBACK = 0.01`,
  `WAKE_FB_REFERENCE: ReferenceSpec`. Zero server imports (client-safe).
- `fieldOwnership.ts` — `resolveWakeFieldOwnership` (all known keys `"computed"`).
  Zero server imports.
- `calc.ts` — `computeWakeFigures` (pure) + `computeWakeWorksheet` (glue:
  reads both Square tax ids from `ctx.profile`, fetches bases + rate,
  reconciles). + `calc.test.ts`.
- `template.ts` — assembles the `TaxPartyTemplate` and calls `registerParty`.
- `lib/tax/parties/index.ts` (modify) — add `import "./wakeCountyFoodBeverage/template";`.

**New UI:**
- `app/finance/tax/parties/WakeCountyFoodBeverage/Worksheet.tsx`.
- `app/finance/tax/parties/WakeCountyFoodBeverage/fieldOwnership.ts`.
- `app/finance/tax/parties/registry.ts` (modify) — add the module entry.

**Type:**
- `lib/tax/rates.ts` (modify) — add `"prepared_food"` to the `TaxRate.category`
  union.

## Testing

Per project rules, new `lib/` logic ships with co-located `*.test.ts`:

- `lib/tax/squareTaxBase.test.ts` — the extracted fetcher (base = net−tax,
  collected = amount, dedupe by line_item_id, pagination). Moved/adapted from the
  existing Sales & Use calc test coverage of `fetchTaxableBase`.
- `lib/tax/parties/wakeCountyFoodBeverage/calc.test.ts` — `computeWakeFigures`:
  tax owed = round(applicable × rate); gross-receipts-null when general id unset;
  reconciliation warning fires past tolerance and stays silent within it; rate
  fallback when the `tax_rates` row is absent.

`npm run verify` (lint + typecheck + tests) is the definition of done.

## Out of Scope

- No penalty / interest / timely-discount lines (explicit scope: three figures).
- No e-filing / transmission to Wake County (consistent with the other parties).
- No changes to the generic tax core, API routes, settings pages, or cron.
- No backfill of historical Wake County filing periods (the schedule generates
  tasks going forward, same as the other parties).

## Open Items (human-gated, post-merge)

- Apply migration `20260803_wake_county_food_beverage_tax.sql` to prod (after
  backup + explicit OK).
- In the app: enter the Wake County Gross Receipts Account # (Tax Profile →
  Registrations) and the 4-digit PIN + Square tax mappings (Tax Filing → Wake
  County module), then create the monthly schedule.
