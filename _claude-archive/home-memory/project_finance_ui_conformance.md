---
name: project_finance_ui_conformance
description: Finance tab UI-standard conformance + UX fixes — PR
metadata: 
  node_type: memory
  type: project
  originSessionId: ae088ae8-d730-4412-af8d-c9c06ccd9e58
---

2026-07-16/17: Full UI review of the Finance tab + subtabs against `docs/UI_STANDARD.md` and interaction conventions, then remediation. **PR #216 MERGED** (squash) + **PR #217 MERGED** (follow-up: header top-padding + description consistency across Financials/Transactions/Settings, matching the Tax/Payroll `<main>` template). Worktree + branches cleaned up. Verify green (lint 0, typecheck, 1608 tests, build OK).

**Durable facts:**
- New sanctioned `text-2xs` (10px) type tier in `globals.css` + UI_STANDARD.md §1 — the ONLY allowed sub-`xs` size (dense table meta). All finance `text-[Npx]` migrated to it.
- New shared primitives: `app/components/ui/SaveHint.tsx` (transient "saved ✓" for auto-save ledgers) and `app/components/ui/ConfirmDialog.tsx` (replaces native `confirm()`/`alert()`).
- `app/finance/settings/layout.tsx` now owns Settings chrome with a **static "Settings" title** (finance titles by area name; sub-tab identifies the view) — mirrors `transactions/layout.tsx`.
- Deposit/BS violet data-category colors live ONLY in `app/finance/lib/categoryColors.ts` (`DEPOSIT_BS_TOGGLE_CLS`, `DEPOSIT_SURFACE_CLS`, `DEPOSIT_TEXT_CLS`, `DEPOSIT_BS_PILL_CLS`). See [[project_ui_consistency_pass]].

**⚠️ OPEN human action:** migration `supabase/migrations/20260802_coa_reference_count.sql` must be **applied to prod** — the new CoA per-row Delete calls `coa_reference_count()` and returns 500 until the function exists. Per [[feedback_prod_db_migration_authorization]], orchestrator applies only after explicit OK + backup.

**Other follow-ups:** (1) Invoices/Bank Ledger use CLIENT-side display pagination (Orders stays server-paged) so their full search + summary totals stay accurate — unifying to server-side pagination+search across all three ledgers is the tracked next step. (2) `BulkSourceMapper` floated panel left un-de-floated (layout risk). (3) Live authenticated visual verification not done — `/finance` is admin-gated.
