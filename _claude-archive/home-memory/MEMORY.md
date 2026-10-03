# Memory Index

One line per entry — detail lives in the topic file. ⚠️ = action needed.

## ⚠️ Open gates

**Backfills to run**
- ⚠️ [Tips pass-through](project_tips_balance_sheet_passthrough.md) — #283/#284/#294 merged, migrations applied. **Backfill has NEVER run** (its gate was unsatisfiable until #294). Settings → Payroll → Backfill.
- ⚠️ [Sales tax in revenue](project_sales_tax_in_revenue.md) — #286 merged, migrations applied (renumbered 20260827/28 by #291). **Backfill not run**; expected figures in the topic file (they drift as orders sync). Also needs: recode the 2026-06-17 −$118.83 Wake payment, opening-balance entry for June's $1,415.33 pre-POS remittances. `2250 Wake County Tax Payable` now exists.
- [Deposit invoice breakdown](project_deposit_invoice_breakdown.md) — 18 deposit invoices, 0 breakdowns; migration 20260709 + backfill PENDING.
- [Deposit recognition retirement](project_deposit_recognition_retirement.md) — backfill (May $1,665.83) + migration 20260802; not merged.
- ⚠️ **Do NOT run** the Tax line-item backfill — no dry-run, delete-then-inserts from a live Square fetch; `pos_line_item_taxes` reconciles perfectly (0 mismatches).

**Data integrity**
- ⚠️ [Payroll drops unmapped-department wages](project_payroll_dropped_unmapped_wages.md) — `computeGlBucketTotals` skips an employee's gross when their department is unmapped, silently. **May payroll short $750.60.** Gate fixed; **upload path NOT fixed**.
- ⚠️ [Tax GL model](project_tax_gl_model.md) — tax hits P&L iff TPB is the taxpayer. `6451` = $0.00 vs `4330` = +$2,085.45, so income overstated. `NC DEPT REVENUE → 2220` rule miscodes excise as sales tax. TODO: rename `6452`, create `1310 Security Deposits Paid`.
- ✅ [coa_reference_count](project_coa_reference_count_broken.md) — FIXED (#302, applied). Was 42703 from the grandfathered 20260802 prefix collision; now has arms for manual_entries + the 3 balance tables.
- ⚠️ [Balance sheet GL mapping](project_balance_sheet_gl_mapping.md) — #300 + #310 merged AND applied; cleanup #312 open. **Never seen in a browser** — 3 of 4 Criticals rendered as empty states, not errors.
- [Square token rotation](project_square_token_rotation.md) — live PROD token still in git history; rotate + update .env.local & Vercel.

**Pending migrations**

- [Brand Guide intros](project_brand_guide_intro_blocks.md) 20260818 · [Packaging materials](project_packaging_materials_breakdown_and_fee_grouping.md) 20260817 (invoices route 500s) · [Wake County F&B](project_wake_county_food_beverage_tax.md) 20260803 · [Finance UI conformance](project_finance_ui_conformance.md) 20260802 (CoA delete 500s) · [Tax rates](project_tax_rates_and_registrations.md) 20260728 · [Grant-aware RLS](project_rls_grant_aware_policies.md) 20260822 · [Inventory↔Square](project_inventory_square_reconciliation.md) 20260722/23 · [Cold storage](project_cold_storage_breakdown.md) 20260717/18 · [Brand system](project_brand_design_system.md) 20260811/13
- [Tax submission module](project_tax_submission_module.md) — built, NOT merged; 2 migrations + Storage bucket + backfill + env.
- [Taproom sync race](project_taproom_sync_race.md) cleanup SQL · [QB sync status](project_qb_sync_status_transactions.md) one Ramp sync

**Never seen in a browser** (login wall) — all merged, all cosmetic risk only
- ⚠️ [Shipment editing](project_shipment_editing.md) #307 — NOT cosmetic-only: a whole new Edit modal + guard surface on Production > Shipments, migration applied, never opened.
- [Recipe search](project_recipe_search_shipments_invoices.md) #297 · [Floorplan/Batch Log/Export](project_floorplan_batchlog_export_fixes.md) #295 · [Export Bay](project_export_bay_false_all_reconciled.md) #293 · [Brewer deposit invoices](project_brewer_deposit_invoices_and_inventory_gates.md) #290 · [Settings nav](project_settings_nav_group_restructure.md) #287 (`MappingGrid.tsx:198` max-h mistuned) · [Payroll day grid](project_payroll_day_override_grid.md) #277/#289
- ✅ The payroll backfill panel HAS been seen (2026-07-29 screenshot) — and immediately exposed the unsatisfiable gate. Visual checks find real bugs.

## Open PRs
- None as of 2026-07-31 (post-#309). ⚠️ Never trust this line without `gh pr list --state open`.
  This section was once stale by 12 entries.

## Durable gotchas & conventions
- ⚠️ [Always link migration files directly](feedback_link_migration_files_directly.md) — every time, unprompted; they apply by hand, and worktree paths + re-stamps go stale.
- ⚠️ [audit_trigger_fn needs an `id` column](feedback_audit_trigger_needs_id_column.md) — on a composite-key table every INSERT dies 42703. Left a migration with tables but ZERO seed rows; 2500 tests, CI and two Opus reviews all missed it. Verify seeds by querying.
- ⚠️ [apply_grant_policies is ADDITIVE-ONLY](feedback_apply_grant_policies_additive_only.md) — alone it denies every non-`custom` role, and a no-policy SELECT returns **zero rows with no error** (reads as an empty state, silently zeroes revenue). Pair it with a role policy or an admin-client route.
- ⚠️ **Squash-merges strand later commits** — `git merge-base --is-ancestor` reports merged branches as unmerged; use `gh pr list --head <branch>`. Re-check PR state after every push.
- ⚠️ [Migration prefix collision](project_draft_swap_tap_transitions.md) — CLI keys on digits before the first `_`. **Recurred 2026-07-30**: a parallel branch took 20260902 mid-flight and CI caught it only after the PR opened; 20260903 was gone too. **Take a full `YYYYMMDDHHMMSS` stamp for new migrations**, not a plain date. Note the guard GRANDFATHERS known duplicates (incl. 20260802), so "clean" ≠ no collisions.
- ⚠️ [Worktree deleted mid-session](feedback_worktree_deleted_mid_session.md) — a concurrent session's cleanup wiped an active worktree AND branch. Also: the user may switch branches in a shared checkout mid-session, silently redirecting your commits. Verify HEAD advanced on YOUR branch.
- ⚠️ [Subagent worktree cwd leak](feedback_subagent_worktree_cwd.md) — pass ABSOLUTE paths; stale same-named briefs in the parent checkout will shadow relative ones and the agent will confidently do the wrong task.
- ⚠️ [Line item description ≠ note](project_invoice_line_item_description_vs_note.md) — `.description` is the catalog label; the real note is `.note`. Send the NOTE to Square.
- ⚠️ [Text ramp dead in Tailwind v4](project_text_ramp_utilities_tailwind_v4.md) — dead token classes pass verify AND the grep guard; detect by computed style.
- ⚠️ [FilterBar phantom wrap](project_filterbar_phantom_wrap.md) — measure computed widths before guessing at flex utilities.
- ⚠️ [cold_storage_inventory aggregates per (batch, variation)](project_b035_wiggo_packaging_double_entry.md) — `source_transfer_id` = last transfer that touched the row, not its creator.
- [Packaging Variations embed](project_packaging_variations_breaks_into_embed.md) — non-canonical FK name → constraint-name embed = PGRST200.
- [Migration drift](project_migration_drift_brew_activities.md) — suspect unapplied migrations on any PGRST200. `42703` on SELECT = column absent; `PGRST204` on write = ambiguous, probe with a SELECT.
- [PostgREST truncates at 1000 rows](project_tax_submission_module.md) — use `lib/supabase/paginate.ts`, and page on a UNIQUE key or pages overlap.
- [Excise channel liability](project_excise_channel_liability.md) — contract_brewing + distribution, NOT wholesale; report as actually-charged.
- [Draft-restock phantom export](project_draft_restock_phantom_export.md) — no variation_id on `export_transactions`; **no generated Supabase types**.
- [Light-mode brand skin](project_light_mode_contrast_brand_skin.md) · [UI consistency](project_ui_consistency_pass.md) · [Button standard](project_button_style_standard.md) — don't tokenize data-category ramps; v4 only emits USED palette vars.
- [Prod data-correction dry run](feedback_prod_data_correction_dryrun.md) — wrap in a `DO` block that RAISEs its verification payload.
- [Prod DB migration authorization](feedback_prod_db_migration_authorization.md) — subagents never apply migrations; orchestrator only, after OK + backup. Verify "applied" claims; a partial apply looks identical to a full one.
- [Frozen tests as equivalence gate](feedback_frozen_tests_as_equivalence_gate.md) — freeze expected VALUES, extend fixtures. A fixture that doesn't match prod can hide the bug entirely.
- [Final review catches real bugs](feedback_final_review_catches_real_bugs.md) — never skip it. It caught a daily-recurring data corruption in #286.
- [Subagent git stash hazard](feedback_subagent_git_stash_hazard.md) · [content fabrication](feedback_subagent_content_fabrication.md) · [real PII in fixtures](feedback_real_pii_in_test_fixtures.md)
- [Batch backfill rules](feedback_backfill_rules.md) — stage names, actual_end, FK insert order, pre-insert checklist.

## Merged / done
- [Manual Entries in Finance > Transactions](project_balance_sheet_gl_mapping.md) #300 — `manual_entries` table, flow/balance kinds, audit trigger; removed from Taproom > Targets
- [Other Assets account type](project_tax_gl_model.md) #298 · [Backfill panels in Settings](project_backfill_panels_settings.md) #292 · [B-035 Wiggo](project_b035_wiggo_packaging_double_entry.md) #296 · [Brand canon silent save](project_brand_canon_silent_save_failure.md) #282 (Supabase resolves with `{error}` — check it on EVERY query, selects included)
- [Scope restructure](project_scope_structure_restructure.md) #285 + [settings consolidation](project_settings_nav_group_restructure.md) #287 — `/settings/<group>/<subtab>`; `NavEntry.requiresAny` for cross-scope groups
- [sort_order contiguity](project_invoice_line_item_sort_order_contiguity.md) #279 · [invoice note](project_invoice_line_item_description_vs_note.md) #278 · [draft swap taps](project_draft_swap_tap_transitions.md) #269 · [variant_label resolve](project_export_product_lines_variant_label_resolve.md) #268 · [manual guards](project_transaction_manual_guards.md) #266 · [packaging materials charge](project_invoice_packaging_materials_charge.md) #265/#267 · [shipment channel billing](project_shipment_channel_billing_exceptions.md) #260
- [returns attribution](project_taproom_returns_attribution.md) #232 · [canceled orders](project_canceled_orders_voided_line_items.md) #229 · [Ramp bill dedup](project_ramp_bill_settlement_dedup.md) #228 · [tax tab search](project_tax_tab_search_filter_backnav.md) #223 · [ghost variation links](project_ghost_duplicate_packaging_variation_links.md) #212 · [B-038](project_b038_duplicate_canning.md)/[B-027](project_b027_miscan_fix.md)
- [payroll GL split](project_payroll_gl_account_split.md) #200/#211/#214 · [B-C-710 excise](project_beer_excise_bc710_module.md) #179 · [tax settings](project_tax_settings_restructure.md) #178 · [financials consolidation](project_financials_consolidation.md) #174 · [line-item unification](project_invoice_line_item_unification.md) #161/#165 · [net terms](project_invoice_net_terms.md) #160 · [automap trigger](project_transactions_automap_trigger.md) #158 · [RLS rollout](project_rls_rollout.md)
- [Brand Guide subtab split](project_brand_guide_subtab_split.md) — not PR'd; chop/labelChassis/naming/visibility have NO UI editor
- [Order-sync cron/webhook incident](project_order_sync_cron_webhook_incident.md) — registry fix NOT merged

## Backlog / planning
- [Batch backfill state](project_backfill_state.md) — B-045 next (Epic Hazy IPA)
- [Ramp unified ledger](project_ramp_unified_ledger.md) · [SKU mapping consolidation](project_sku_mapping_consolidation.md) · [Three-channel invoicing](project_three_channel_invoicing.md) · [Stability hardening](project_stability_hardening.md) · [Orchestration handoff](project_orchestration_handoff.md)
