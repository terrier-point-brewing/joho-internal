---
name: project_beer_excise_bc710_module
description: "NC DOR Beer Excise (Form B-C-710) tax module — 2nd independent tax party, MERGED to main via squash PR #179 (2026-07-14)"
metadata: 
  node_type: memory
  type: project
  originSessionId: dceb14ee-26f2-43aa-b1fa-8db47ccf63b6
---

2026-07-13: Built the **NC DOR Beer Wholesalers/Resident-Brewery Excise Tax Return (Form B-C-710)** as a second independent tax party (`nc_dor_beer_excise`) in `finance > tax`, mirroring the [[project_tax_submission_module]] NC DOR Sales & Use party. **Phases A+B COMPLETE & MERGED to main via squash PR #179 (2026-07-14).** Final Opus whole-branch review = READY TO MERGE; verify green (1379 after main merge). Branch + worktree cleaned up post-merge.

**Architecture:** pure party-plugin add — new `lib/tax/parties/ncDorBeerExcise/{rates,derive,fieldOwnership,calc,template}.ts` + client `app/finance/tax/parties/NcDorBeerExcise/{Worksheet,fieldOwnership}.tsx` + `lib/tax/beerExciseWorksheetMath.ts`; registered via `lib/tax/parties/index.ts` + client `registry.ts`. NO generic-core / DB-schema / cron / route changes. Monthly only, due 15th of following month.

**Numbers logic (locked with user):** sources gallons from `export_transactions` keyed on `created_at` (ship/disposal date), gallons = `volume_bbl × 31`. Taxable channels = distribution + contract_brewing + taproom; **wholesale = Line 4a deduction (never taxed)** — consistent with [[project_excise_channel_liability]] (`lib/finance/invoiceSalesReport.ts` EXCISE_LIABLE_CHANNELS) except taproom is ADDED here (taproom excise lives only on export_transactions, never invoiced). Waterfall: L2=all channels, L4a=wholesale, L5=taxable (floored ≥0), L6 = L5 × NC rate, L7 = 2% timely discount, L11 = net+penalty+interest. Rounding once per figure; printed form self-consistent (L6 = displayed L5 × rate). Client live-edit + server compute/merge both call the one pure `deriveBeerExciseFigures`.

**Rate:** Line 6 reads the live rate via the canonical `tax_rates` accessor (`lib/tax/rates.ts::getTaxRate`, key `nc_dor_beer_excise`), statutory fallback $0.6171 = 617100 micros. Drift + coverage (missing-excise-detail, incl. taproom) warnings surface in worksheet. **NOTE (2026-07-14): a later PR (#184, [[project_tax_rates_and_registrations]]) renamed `excise_tax_rates`→`tax_rates` and re-pointed this module's `calc.ts`/`rates.ts` at the new table/key — already reconciled on main, verify green.** `getTaxRate` throws (not null) on a genuine query/schema error — so this module will 500 on any recompute until migration `20260728_tax_rates_and_registrations` is applied (see that memory: still OPEN/not applied to prod as of last check).

**Settings split:** beer-only party settingsSchema = abc_permit_number/state_of_domicile/fax_number/signer_title (+ new shared `lib/tax/usStates.ts` for the state select). NOTE: do NOT spread identity into a party settingsSchema — the tax-filing page renders per-party settingsSchema only.

**MERGE with main (2026-07-13, commit a8bd80c):** [[project_tax_settings_restructure]] (#178) merged to main FIRST and **deleted `lib/tax/identity.ts`** (the shared IDENTITY_SCHEMA), replacing it with a singleton **entity profile** `lib/tax/entity.ts` `ENTITY_PROFILE_SCHEMA` (legal_name/fein/ssn/contact_*/address_line1/address_line2/city/state/postal_code) on the new Tax Profile page. So my Phase-A identity-extension (Task 6) became redundant — resolved the modify/delete conflict by ACCEPTING the deletion; kept usStates.ts, fixed usStates.test.ts. PR #179 now MERGEABLE, verify green 1379 tests. **Entity identity (legal name/FEIN/address) is now the singleton, shared across parties — the BC-710 reads it from there, not per-party.** Phase C PDF-fill will need a **trade_name** field (BC-710 has Trade Name; ENTITY_PROFILE_SCHEMA does NOT — add to entity profile when building Phase C).

**OPEN follow-ups (human-gated):**
1. ~~Set NC rate 0.62→0.6171 manually~~ SUPERSEDED — migration `20260728_tax_rates_and_registrations` (part of #184) sets `nc_dor_beer_excise` rate to 0.6171 automatically when applied. **Applying that migration is now a hard functional dependency for this module** (not just a correctness nice-to-have), since `getTaxRate` throws if `tax_rates` doesn't exist yet.
2. Create first beer-excise schedule + identity profile (identity now lives on the singleton entity profile, [[project_tax_settings_restructure]]).
3. Browser E2E verify (app gates /finance behind login — couldn't be done headlessly).
4. **Phase C (PDF auto-fill): explicitly punted by user 2026-07-14, not scheduled.** Fully scoped and ready whenever wanted — plan Tasks 11-12 in `docs/superpowers/plans/2026-07-13-nc-dor-beer-excise-tax.md`, full BC-710 AcroForm field map already extracted. `pdf-lib` not yet a dep. Needs `trade_name` added to entity profile first (see above).

**Cleanup (2026-07-14):** a duplicate/stale worktree+branch (`nc-dor-beer-excise-tax-362215`, fully merged, no uncommitted work) from a separate session was found and removed; the original `32b067` worktree/branch were already cleaned up at initial merge time.
