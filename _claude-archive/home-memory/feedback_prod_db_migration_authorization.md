---
name: feedback-prod-db-migration-authorization
description: Orchestration policy — feature subagents must never apply migrations to the live prod Supabase DB; orchestrator applies per-migration only after explicit user OK
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f8724011-e2ba-4a06-b368-b550b0e613bc
---

When orchestrating feature work on this repo (see [[project_orchestration_handoff]]), dispatched subagents are **never** authorized to apply migrations or any DDL/DML to the live production Supabase DB (`drlsazatrcrdwaihjmex`) or its branches. They WRITE migration files only.

**Why:** `origin/main` auto-deploys to prod and the DB is the live production store; a wrong/destructive migration is hard to reverse. The auto-mode classifier correctly blocked a subagent prompt that authorized live-DB migrations on 2026-06-28 — the user's dispatch/git answers did not cover production schema changes.

**How to apply:** Subagent prompts must explicitly forbid `apply_migration`, write-`execute_sql`, `merge_branch`, and psql/Supabase mutations (read-only SELECT/anon-REST GET are fine). When a migration is ready, the orchestrator shows it to the user, takes a backup (e.g. dump `export_transactions` before the destructive `20260708_export_invoice_fk.sql`), and applies to prod **only after the user approves that specific migration**. Git integration policy this session: merge green branches to local `main`, do NOT push to `origin` (user owns the prod-deploy push).
