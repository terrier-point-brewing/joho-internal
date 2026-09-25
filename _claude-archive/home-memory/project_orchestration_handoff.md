---
name: project_orchestration_handoff
description: "Active orchestration handoff (2026-06-28) — main pushed, 3 features queued for parallel/sequenced sub-agent worktree sessions"
metadata: 
  node_type: memory
  type: project
  originSessionId: ef1267c7-fc19-462f-909e-04292d2361a2
---

As of 2026-06-28, the session role shifted to **orchestrator** for three queued features, executed in isolated git worktrees by fresh sub-agent sessions.

**Source of truth:** `docs/superpowers/2026-06-28-orchestration-handoff.md` (committed) — read it fully before orchestrating. It holds base state, the live-schema reality, conventions, per-feature plans, sequencing, integration plan, and ready-to-paste session prompts.

**Base:** `main` is pushed to `origin` (`terrier-point-brewing`, auto-deploys to prod). Build passes.

**Features + sequencing (locked):**
- #1 Employee shift & payroll — independent, run in PARALLEL (`feature/payroll-shifts`).
- #2 Square SKU mapping consolidation (recipe × packaging-variation grain) — SEQUENCE 1 (`feature/sku-mapping-consolidation`); must merge first.
- #3 Phase 2 export UI redesign + deferred UX polish — SEQUENCE 2, branch off post-#2 main. #2 and #3 collide on `exportInvoicePreview.ts`/`recipe_square_links`/`RecipeLinkMatrix`.

**Critical:** ~15 morning migrations are APPLIED; code reconciled (recipes.brewery→partner_id, commitments.beer_style→recipe_id, etc.). `20260708_export_invoice_fk.sql` is NOT applied — Feature #3 owns it. Safety branch `backup/morning-export-redesign-20260628` is the recovery source for ShipmentsTab/ExportInvoicesTab. See [[feedback_backfill_rules]] for related batch rules. Verify schema via Supabase MCP (`drlsazatrcrdwaihjmex`) + anon-key REST embed checks.
