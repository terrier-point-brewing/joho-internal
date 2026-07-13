# NC DOR Beer Wholesalers Excise Tax Return (Form B-C-710) — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorming) — pending spec review
**Area:** `finance > tax` (second independent tax party)

## Goal

Add a second independent tax module to `finance > tax`: the **NC DOR Malt Beverages
Wholesaler/Importer/Resident-Brewery Excise Tax Return, Form B-C-710**, filed monthly.
Unlike the first party (NC DOR Sales & Use, an online filing), this return is
**printed and physically mailed**, so a stretch goal is auto-generating a filled BC-710
PDF from the worksheet.

**Primary priority: the numbers and line-mapping must be correct.** The PDF auto-fill is
an explicit stretch goal (Phase C), separable from a correct, usable module (Phases A–B).

## Background / existing systems this builds on

The tax module is a **party-template plugin system**. A party supplies all tax-specific
logic; the generic core (routing, scheduling, task lifecycle, worksheet chrome, settings,
cron, storage) is party-agnostic and needs **no changes**. Reference party:
`lib/tax/parties/ncDorSalesUse/` (`template.ts`, `calc.ts`, `derive.ts`,
`fieldOwnership.ts`, `rates.ts` + co-located tests). Contract: `TaxPartyTemplate` in
`lib/tax/types.ts`. Client worksheet contract: `PartyWorksheetModule` /
`PartyWorksheetProps` in `app/finance/tax/parties/registry.ts`.

Excise data already exists. `export_transactions` (one row per shipped/disposed package
run) carries `channel ∈ {taproom, distribution, contract_brewing, wholesale}`,
`volume_bbl` (barrels), `total_excise_tax_usd`, `created_at` (the de-facto ship/record
date — there is no separate ship_date), and child rows `export_transaction_taxes`
(`tax_name`, `amount_usd`) frozen at write time via
`lib/production/exportTransactionWriter.ts`. `GALLONS_PER_BBL = 31`
(`lib/constants/production.ts`). Configurable rates live in `excise_tax_rates`
(`name`, `unit ∈ {bbl,gallon}`, `rate_usd`, `is_active`), edited via
`finance > settings > excise-tax`.

### Key facts driving the design (from BC-710 extraction + codebase research)

- **Statutory rate: $0.6171/gallon**; **2% discount** if the return with full payment is
  filed timely. Penalty/interest are per-period, not printed.
- Form math (Part 1): `L3=L1+L2`, `L5=L3−4a−4b−4c−4d`, `L6=L5×rate`, `L8=L6−L7`,
  `L11=L8+L9+L10`. Parts 2/3/4 are line-item schedules feeding L2, L4b, L4c.
- **Channel liability** (per `lib/finance/invoiceSalesReport.ts`): distribution +
  contract_brewing are TPB's liability; **wholesale is NOT** (the receiving NC wholesaler
  owes it). **Taproom** is stored with excise on `export_transactions` but is excluded
  from the invoice report — this return **must include taproom** and therefore must source
  from `export_transactions` directly (keyed on `created_at`), not the invoice report.
- ~130 AcroForm fields, field-name prefix `BC710wf_`. Static identity vs per-period split
  is documented in `scratchpad/fields_by_page.txt` (reference for Phase C mapping).

## Decisions (locked)

1. **Taxable channels (Line 5):** distribution + contract_brewing + taproom. Wholesale →
   deduction (Line 4a).
2. **Waterfall mapping:** all-disposed-minus-deductions (Line 2 = all channels; Line 4a =
   wholesale + manual; inventory Lines 1/4d = 0 — this system tracks disposal, not gallon
   inventory).
3. **Schedules:** summary rows by channel (fits the form's ~8 rows; sums to Line 2).
4. **NC rate source:** the configurable `excise_tax_rates` "NC" row, **updated to
   $0.6171** in `finance > settings > excise-tax`. Accepts the forward side effect that new
   shipment excise stores at $0.6171 (a correctness improvement over the $0.62 seed).
5. **Settings/module split:** general business-identity fields added to the **shared**
   `IDENTITY_SCHEMA` (visible to all parties); beer-only fields in the party's own
   `settingsSchema`.
6. **Frequency:** monthly, due the 15th of the following month.

## Architecture

New party `ncDorBeerExcise`. Files to add:

**Server — `lib/tax/parties/ncDorBeerExcise/`**
- `rates.ts` — statutory constants (`$0.6171/gal`, `2%` discount), `referenceView` tables,
  helper to read the live NC rate from `excise_tax_rates`.
- `derive.ts` — **pure**, zero server imports, client-importable. Single source of truth
  for all Part 1 line math + schedule totals. Mirrors `ncDorSalesUse/derive.ts` shape.
- `fieldOwnership.ts` — pure `computed` vs `manual` classifier over the field key space.
- `calc.ts` — server-only I/O: `computeBeerExciseWorksheet(ctx)` runs the period query
  (dynamic `import("@/lib/supabase/admin")`), builds initial fields via `derive.ts`, emits
  drift + coverage warnings.
- `template.ts` — assembles the `TaxPartyTemplate` (period/due rules, `settingsSchema`,
  `scheduleConfigSchema` (likely empty), `referenceView`, `mergeWorksheet`,
  `worksheetComponent: "NcDorBeerExcise"`), ends with `registerParty(...)`.
- Register: add `import "./ncDorBeerExcise/template";` to `lib/tax/parties/index.ts`.

**Client — `app/finance/tax/parties/NcDorBeerExcise/`**
- `Worksheet.tsx` — Part 1 (Lines 1–11) + Parts 2/3/4 summary section + toggles; live
  client recompute via the shared `derive.ts`.
- Register in `app/finance/tax/parties/registry.ts` `WORKSHEET_MODULES` under key
  `"NcDorBeerExcise"`, exporting `{ Worksheet, getTotalDueCents }`.

**Shared identity — `lib/tax/identity.ts`**
- Extend `IDENTITY_SCHEMA` with: `legal_name`, `trade_name`, `mailing_address`, `city`,
  `state`, `zip`. Additive; sensitive handling unchanged; Sales & Use inherits them
  harmlessly (E-500 also has business name/address).

**No new tables. No generic-core changes. No new API routes.**

## Data flow & period query (`calc.ts`)

`ComputeContext { schedule, profile, period }`. For the period `[monthStart, nextMonth)`:

```
rows = export_transactions
         .select(channel, volume_bbl, total_excise_tax_usd,
                 export_transaction_taxes(tax_name, amount_usd))
         .gte(created_at, monthStartUTC)
         .lt(created_at, nextMonthStartUTC)

gallons(channel) = Σ volume_bbl(channel) × 31        // GALLONS_PER_BBL
ncRateUsd        = active excise_tax_rates row where unit='gallon' & name~'nc'  (→ 0.6171)
```

Channel buckets: `distribution`, `contract_brewing`, `taproom` (taxable); `wholesale`
(deduction). Cents everywhere.

**Warnings emitted into `worksheet.warnings`:**
- *Rate drift:* `|L6 − Σ storedNcExcise(taxable channels)| > max(100¢, 0.1%·stored)`
  (flags legacy rows stored at $0.62, or missing detail).
- *Coverage gap:* count taxable-channel rows with `volume_bbl>0` but no NC
  `export_transaction_taxes` row (extends the existing coverage counter to taproom, which
  the invoice-report counter ignores).

## Line math (`derive.ts`, pure)

Inputs = the field bag. `computed` fields recomputed here; `manual` fields preserved by
`mergeWorksheet` on recompute (same pattern as Sales & Use).

```
gallons_distribution, gallons_contract, gallons_taproom, gallons_wholesale   // computed from calc
L1  beginning_inventory      = 0
L2  produced_for_sale        = gallons_distribution + gallons_contract + gallons_taproom + gallons_wholesale
L3  total_available          = L1 + L2
L4a allowable_deductions     = gallons_wholesale + manual_extra_deductions(0)
L4b adjustments_part3        = manual (0)
L4c military_part4           = manual (0)
L4d ending_inventory         = 0
L5  taxable_gallons          = L3 − L4a − L4b − L4c − L4d
L6  excise_due_cents         = round(L5 × ncRateUsd × 100)
L7  discount_cents           = timely_toggle ? round(L6 × 0.02) : 0    // manual override allowed
L8  net_tax_due_cents        = L6 − L7
L9  penalty_cents            = manual (0)
L10 interest_cents           = manual (0)
L11 total_payment_due_cents  = L8 + L9 + L10
```

**Rounding (decided) — the printed form must be self-consistent.** Because the return is
mailed and an auditor recomputes L6 from the L5 printed on paper, L6 is computed from the
*same displayed* taxable-gallons value, not an unrounded one: `L6 = round(L5_display ×
ncRateUsd × 100)` cents. Per-channel gallons (`volume_bbl × 31`) are rounded to the DOR
display granularity (default **whole gallons** — confirm against the BC-710 instructions;
the multiplicand and the printed value are identical either way). The stored-excise
cross-check is therefore a *tolerance* comparison (rounding + any legacy $0.62 rows), never
an equality assertion. `getTotalDueCents(fields) = L11`.

**Schedule summary rows (Part 2 → L2):** one row per channel with nonzero gallons
(`invoice_date` = period end or blank, `supplier` = channel label, `gallons` = channel
total). Parts 3/4 default empty (manual). Wholesale deduction is Line 4a only (the form
gives 4a no schedule).

## Field ownership

`computed`: all `gallons_*`, L2, L3, L5, L6, L8, L11, discount (when toggle-driven),
schedule summary rows. `manual`: L1/L4d (fixed 0 but user-adjustable if ever needed),
L4a extra, L4b, L4c, L9, L10, timely toggle, amended/no-transaction checkboxes, signer
date. `template.ts` wraps the classifier in a `Proxy` over the unbounded key space (as
Sales & Use does).

## Settings vs module

**Shared `IDENTITY_SCHEMA` (settings, all parties):** contact_name/email/phone,
account_id (per-party NCDOR ID), fein, ssn, **+ legal_name, trade_name, mailing_address,
city, state, zip**.

**Beer party `settingsSchema` (spreads IDENTITY_SCHEMA, then adds):**
`abc_permit_number`, `state_of_domicile` (select, same state list as the form),
`fax_number`, `signer_title`.

`scheduleConfigSchema`: empty (no county weights; unlike Sales & Use). Due-rule editor in
the schedule modal still applies generically.

## Worksheet UI

Mirrors the paper form using existing shell chrome (`TaxWorksheetShell` provides header,
masked identity card, warnings banner, recompute, autosave, total-due footer,
`CompletePanel`). The component renders:
- **Part 1** — Lines 1–11 as a labeled column; computed = read-only, manual = `.inp`
  editable; live recompute on keystroke via `derive.ts`.
- **Toggles** — timely-filed (drives discount), amended return, no transactions.
- **Parts 2/3/4** — summary rows (read-only, computed) with per-part totals.
- **Signature block** — signer title (from settings, overridable), signature date.
Follows `docs/UI_STANDARD.md`: token utilities only, `.inp`/`.btn-*`, `<Field>`, no raw
colors or hand-rolled primitives.

## Filing schedule

`supportedFrequencies = ["monthly"]`. `computePeriod("monthly", ref)` = `monthPeriod` +
due date. `defaultDueRule("monthly") = { monthOffset: 1, day: 15 }`. Cron + task
generation already generic.

## Rate configuration (operational)

Before first real filing: set the `excise_tax_rates` NC gallon row `rate_usd` to `0.6171`
via `finance > settings > excise-tax`. The module reads this row live; the drift warning
surfaces any legacy `$0.62` stored rows in a period.

## PDF auto-fill (Phase C, stretch)

1. User uploads the official fillable BC-710 PDF once; stored per-party in the tax Storage
   bucket (reuse `tax-confirmations` or a `tax-templates` prefix, party-keyed).
2. A **"Generate filled BC-710"** action in the worksheet fills the template via `pdf-lib`
   using a hardcoded worksheet→AcroForm map (field names in `scratchpad/fields_by_page.txt`;
   e.g. `BC710wf_Line6`, `BC710wf_Line5`, per-row `BC710wf_MaltBeverageInGallons_1_{n}` +
   `BC710wf_MaltBeverageInGallons_Total_1`, shared `BC710wf_NCDOR IDAccount Number`,
   checkboxes on-state `/Yes`), then downloads the result. Money/gallon fields are plain
   text (form does no math) — the app supplies every computed value.
3. Gotchas: field names contain spaces/mixed case (quote exactly); Part 4 has 7 rows,
   Parts 2/3 have 8; `BC710wf_NCDOR IDAccount Number` is one shared field across pages.

## Testing

Co-located (satisfies the lib/ coverage rule):
- `derive.test.ts` — waterfall (all channels, wholesale deduction, taxable subset),
  discount on/off + override, L11 rollup, schedule-row totals reconcile to L2.
- `calc.test.ts` — mocked Supabase: per-channel gallon aggregation, cents math, drift
  warning threshold, taproom coverage-gap counter, empty period.
- `fieldOwnership.test.ts` — computed vs manual classification incl. unknown keys.
- `template.test.ts` — period/due-date (monthly, day 15), `mergeWorksheet` preserves
  manual edits (penalty/interest/deductions) through recompute.

`npm run verify` (lint + typecheck + tests) is the DoD.

## Phasing & execution

- **Phase A — Numbers engine (server):** rates, derive, fieldOwnership, calc, template,
  registry entry, shared-identity extension, all tests. Independently verifiable.
- **Phase B — Worksheet UI + settings:** `Worksheet.tsx` + client registry entry;
  end-to-end filing flow in the browser. Set NC rate to $0.6171.
- **Phase C — PDF auto-fill (stretch):** template upload + `pdf-lib` fill + download.

Execution: multi-file feature (>6 files) → written plan. Phases A and C touch distinct
file localities; Phase B depends on A. Locality groups: (1) `lib/tax/parties/ncDorBeerExcise`
+ identity, (2) `app/finance/tax/parties/NcDorBeerExcise`, (3) PDF fill. Model per
CLAUDE.md: implementation → Sonnet; final whole-branch review → Opus.

## Out of scope

- Quarterly/annual beer-excise frequencies (form is monthly).
- Beginning/ending gallon-inventory tracking (Lines 1/4d fixed 0).
- Part 3 (purchases from other wholesalers) / Part 4 (military) auto-population — manual,
  default 0 (TPB has none).
- Changing wholesale/taproom liability rules elsewhere in the app.
