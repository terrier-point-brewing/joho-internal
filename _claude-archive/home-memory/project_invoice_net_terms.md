---
name: project_invoice_net_terms
description: Invoice net-terms simplified to single value + draft-date due date; migration 20260727 APPLIED to prod
metadata: 
  node_type: memory
  type: project
  originSessionId: 7a299fda-d7c9-4fb1-bcaf-82ea3bf4085c
---

2026-07-10: Simplified deposit + export invoice net-terms logic (PR #160, squash-merged to main).

**Rule now:** due date = draft date (today, **brewery-local** via `todayLocalDate()`) + a single configurable net-terms value per invoice type. Recomputed on every generate/regenerate (a revision resets the clock). Values live in `system_settings` keys `deposit_invoice_due_days` / `export_invoice_due_days` (default 30), edited only in Production → Settings.

**Removed:** all per-partner net-terms overrides (columns `contract_brewing_partners.export_net_terms_days` / `deposit_net_terms_days`) — they were unreachable in the UI anyway (Partners-tab Edit is disabled for Square-linked partners = the only invoiceable ones). Net-terms resolution now lives in one place: `lib/production/invoiceTerms.ts` (`getNetTermsDays`), replacing copy-paste in 5 sites. Date math uses canonical `lib/utils/datetime` (`addDaysStr` / `todayLocalDate`), not a local UTC helper.

**Other changes:** export flow now persists `due_date` to the `invoices` ledger (was a gap); deposit service date + ledger `invoice_date` now = draft date (was `planned_brew_date`), so `due_date = invoice_date + terms` holds for both flows.

**Migration `20260727_drop_partner_net_terms.sql` APPLIED to prod 2026-07-10** (run manually via Supabase SQL editor after the deploy went live — drop-after-deploy ordering, since old code selected those columns). Drops the two override columns from `contract_brewing_partners`.

Design/plan: `docs/superpowers/specs/2026-07-10-invoice-net-terms-simplification-design.md`, `docs/superpowers/plans/2026-07-10-invoice-net-terms-simplification.md`. See [[feedback_prod_db_migration_authorization]].
