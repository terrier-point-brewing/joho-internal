---
name: project_wake_county_food_beverage_tax
description: "Wake County Prepared Food & Beverage Tax — 3rd tax party added to the Finance tax module, PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4570d98b-ba67-43a8-ad76-c950729e7816
---

2026-07-17: Added **Wake County — Prepared Food & Beverage Tax** as the 3rd tax-filing party in Finance → Taxes, alongside NC DOR Sales & Use Tax and NC DOR Beer Excise Tax ([[project_tax_rates_and_registrations]], [[project_beer_excise_bc710_module]]). Pure plugin addition to the existing `TaxPartyTemplate` registry — zero changes to the generic tax core. **MERGED to main via PR #218** (squash, commit `0e9b820`).

**Shape:** Gross Receipts (Taproom Net Sales, same `fetchTaxableBase` logic as Sales & Use) vs. Applicable Gross Receipts (net sales of items carrying Square's own "Prepared Food & Beverage Tax" catalog tax line, confirmed live `square_tax_id ARI25PLSGLDVIBUQITKTRNSX`) vs. Tax Owed (1%, rate read from `tax_rates` key `wake_county_food_beverage_tax`, not hardcoded). Monthly only, due the 20th of the following month. Contact Name/Email/Phone reuse the existing shared Legal Representative (no new fields) — Wake County Gross Receipts Account # is a new required registration under a new `wake_county` authority; the 4-digit filing PIN is a new `sensitive` settings field (masked present/absent).

**Refactor along the way:** extracted the shared Square-tax-line base fetcher (`fetchTaxableBase`) out of `ncDorSalesUse/calc.ts` into `lib/tax/squareTaxBase.ts` since two parties now need the identical query.

**Why:** Wake County levies a 1% tax on prepared food/beverage sales (NCGS 105-164.4(a)(1) scope), collected by the merchant alongside NC state sales tax, remitted monthly to the county.

**How to apply:** Design spec `docs/superpowers/specs/2026-07-17-wake-county-food-beverage-tax-design.md`, plan `docs/superpowers/plans/2026-07-17-wake-county-food-beverage-tax.md`. `npm run verify` green (1628/1628 tests). Worktree/branch cleaned up post-merge.

**2026-07-17 backfill (done directly against prod via Supabase MCP, user-approved):**
- Migration `20260803_wake_county_food_beverage_tax.sql` **APPLIED** — `wake_county` authority + `wake_county_food_beverage_tax` rate (1%) now live in `tax_authorities`/`tax_rates`.
- `tax_filing_profiles` row created for `wake_county_food_beverage`: `food_beverage_tax_id=ARI25PLSGLDVIBUQITKTRNSX`, `general_sales_tax_id=ADD7EKQD2KN72NOYVUWHU34J` (same Square catalog IDs already used by `nc_dor_sales_use`).
- Monthly schedule for `wake_county_food_beverage` already existed (created same day, id `d2ede1cd-fa91-491b-b0d1-223f423fe54a`) but had zero `tax_tasks` rows (daily cron hadn't run since schedule creation). Manually inserted May (`2026-05-01`–`31`, due `2026-06-20`) and June (`2026-06-01`–`30`, due `2026-07-20`) task rows, then computed+wrote their worksheets by replicating `fetchTaxableBase`/`computeWakeFigures` logic directly in SQL (no dev server/app session available to hit the real recompute route). Results: May tax owed $58.40 vs Square-collected $58.42 (2¢, within tolerance); June $86.44 vs $86.44 exact. Both tasks left in `status=open` — not marked filed/completed.

**Still PENDING (human):**
- Wake County Gross Receipts Account # + 4-digit filing PIN not set (`requiredRegistrations` under the `wake_county` authority) — needed before the return can actually be filed, not needed for the worksheet computation itself.
- Browser E2E verification never done — blocked by lack of app login credentials in the coding session. Someone with access should open Finance → Tax and confirm the May/June Wake County tasks render correctly, then file + mark complete.
