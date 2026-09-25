---
name: project_tax_settings_restructure
description: "2026-07-13 Finance tax settings restructured into Tax Profile + per-authority Tax Filing (excise absorbed); built on branch, human-gated migration pending"
metadata: 
  node_type: memory
  type: project
  originSessionId: c7273d99-4c7f-493c-9003-3a37a1da3d29
---

2026-07-13: Restructured Finance → Settings tax subtabs. Motivating problems: (1) "Excise Tax" and "Tax Filing" subtabs were disjoint systems sharing only the word "tax" (excise = borrowed production `ExportSettingsPanel` over `excise_tax_rates`; tax filing = bespoke party-template engine) — user wanted them unified; (2) the Tax Filing page conflated entity-level identity (FEIN/SSN/contact/address — was stored per-party, duplicated) with per-schedule config (Square sales-tax mapping, NC rate references).

**New structure (2 subtabs, replacing the old 2):**
- **Tax Profile** (`/finance/settings/tax-profile`) — entity-level: filer identity (legal name, FEIN, SSN, contact, address) + a Registrations table (per-authority account/license numbers).
- **Tax Filing** (`/finance/settings/tax-filing`) — per receiving-party: Square mappings + Excise Rates (absorbed) + statutory Reference tables + Schedules link. Excise Tax subtab retired → redirect stub.

**Data model (full structural unification, user-chosen):** new `tax_authorities` spine (`nc_dor` [both], `federal_ttb` [excise]); singleton `tax_entity_profile`; `excise_tax_rates.party_key` FK (legacy free-text `receiving_party` kept + backfilled); `tax_filing_profiles` slimmed (identity moved out, keeps `general_sales_tax_id`). Authority key `nc_dor` is DISTINCT from worksheet-template key `nc_dor_sales_use` (mapped via `TEMPLATE_BY_AUTHORITY` in tax-filing/page.tsx). Decisions: **FEIN visible, only SSN masked** (kept the [[project_tax_submission_module]] waiver).

**Status:** **MERGED to main via squash PR #178** (merge commit ae4c0db6, 2026-07-13); migration `20260713_tax_settings_restructure.sql` APPLIED to prod (user-run); remote branch auto-deleted. Local worktree finance-tax-settings-structure-d213df + local branch cleanup handed to user (git worktree remove --force + git branch -D, run from main checkout — session was inside the worktree so couldn't self-remove). `npm run verify` GREEN (1333 tests, lint/tsc clean). Executed subagent-driven with consolidated per-locality-group spawns (5 impl spawns, not per-task — user flagged context-tax from over-spawning micro-tasks). Final Opus whole-branch review: no Critical/Important; cleared 2 Minor (deleted dead `lib/tax/identity.ts`; migration comment). Plan: `docs/superpowers/plans/2026-07-13-tax-settings-restructure.md`.

**HUMAN-GATED before merge/live** (per [[feedback_prod_db_migration_authorization]]): apply migration `20260713_tax_settings_restructure.sql` (backup first — moves identity out of tax_filing_profiles, backfills party_key), then browser E2E verify. Open follow-ups: split excise React-Query caches (production all-rows key vs finance per-party key) not cross-invalidated (low impact); unmatched excise `receiving_party` rows get null party_key (manual cleanup); dropping legacy `receiving_party` column once export invoicing reads party_key; `ExportSettingsPanel` `scope="excise-only"` branch now dead.
