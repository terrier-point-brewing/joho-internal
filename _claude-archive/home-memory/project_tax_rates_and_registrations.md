---
name: project_tax_rates_and_registrations
description: "Canonical tax_rates table + lower-grain registrations + module-pivoted Tax Filing (branch, migration pending human apply)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 123aa0d6-29fa-4ca7-892b-f4b7720650f2
---

2026-07-13/14: Tax config rework, built subagent-driven from spec+plan in `docs/superpowers/{specs,plans}/2026-07-13-tax-rates-and-registrations*`. Final Opus whole-branch review = READY (no Critical/Important). **MERGED to main via squash PR #184 (2026-07-14, commit c1ab935)** — branch/worktree `claude/tax-profile-issues-10c76e` deleted post-merge. Verify GREEN (1394 tests incl. main's concurrent #182 pagination fix, merged cleanly — only `ncDorSalesUse/calc.ts`/`.test.ts` overlapped, resolved with both changes intact).

Three coordinated changes:
1. **Tax Profile registrations** → lower grain: new `tax_registrations` (authority_key FK → many rows, free-text `label` + `number`, explicit bulk Save via `PUT /api/tax/registrations` reconcile). Dropped `tax_authorities.kind` + `registration_number`; Federal EIN moved out of `tax_entity_profile.fein` into a registration under a new `irs` authority; added `nc_abc` (NC ABC Commission) authority.
2. **Tax Filing settings** now pivots per-MODULE (party template via `/api/tax/parties`), not per authority; all user rate-editing removed (ExciseRatesSection now read-only in production Export Settings; excise-tax-rates POST/PATCH/DELETE routes deleted).
3. **Canonical `tax_rates` table** = `excise_tax_rates` RENAMED in place (preserves `export_transaction_taxes.excise_tax_rate_id` FK). Cols: key(unique)/name/category('excise'|'sales'|'local'|'transit')/party_key/basis('per_bbl'|'per_gallon'|'percent')/rate/is_active; KEPT receiving_party + square_catalog_* (used by buildExciseTaxLines — NOT vestigial). Seeded 116 rows: 2 excise (NC corrected 0.62→**0.6171**), nc_sales_state + line_4..12, 100 nc_local_* + 4 nc_transit_*. Rate STRUCTURE/keys in code (`lib/tax/rates.ts` key builders + accessor `listTaxRates`/`getTaxRate`/`buildRateMap`), VALUES in table. Consumed by production `computeExciseTaxBreakdown`, beer-excise `getTaxRate`, and Sales&Use worksheet via a `rateMap` threaded through `deriveNcDorFigures(fields, rateMap)` (server calc + client Worksheet fetch). `TaxPartyTemplate.referenceView`→`buildReferenceView(rateMap)`; `mergeWorksheet` gained a rateMap arg.

Review Minors (registration blank-label, PUT per-row validation, dead percent-format branch) FIXED pre-merge (commit 86d157e). **OPEN (human-gated, next step):** apply migration `supabase/migrations/20260728_tax_rates_and_registrations.sql` to prod (after backup) — see [[feedback_prod_db_migration_authorization]]; then create registrations in-app (Federal EIN under the new `irs` authority, NC ABC license #). Supersedes the editable-rate approach in [[project_beer_excise_bc710_module]] (beer rate now canonical in tax_rates, no drift). Related: [[project_tax_settings_restructure]], [[project_excise_channel_liability]].
