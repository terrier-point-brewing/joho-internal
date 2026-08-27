---
name: project_stability_hardening
description: "2026-06-30 autonomous program — lib/ test backfill + CI enforcement + schema/dead-code audit; plan pushed, to be run in cloud env"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1dcc856e-e2f8-47b8-8af3-a2d2688b840d
---

2026-06-30: Designed an unattended (18h+) repo-wide stability program to run in a **cloud environment**. Plan committed + pushed to branch `claude/friendly-wozniak-1f1acf` (origin) at `docs/superpowers/plans/2026-06-30-lib-test-coverage-stability-hardening.md`.

**Problem found:** ~52 of 58 `lib/` modules untested (only 6 test files); CI (`.github/workflows/ci.yml`) runs lint+tsc+build but **NOT `npm run test`** — tests don't gate anything.

**Three workstreams, all land as PRs left for review (nothing merged), no live-DB changes:**
- A: enforcement — add `npm run test` to CI + coverage ratchet in `vitest.config.ts` + CLAUDE.md rule.
- B1–B7: parallel lib/ test backfill by domain (finance, payroll, production-core, production-export, square, reports, utils) — characterization tests, no source edits.
- C: read-only schema audit (use `anthropic-skills:supabase-db-audit`) + dead-code report; draft migrations written but NEVER applied (respects [[feedback_prod_db_migration_authorization]]).

**User decisions:** landing = "PRs, leave all for review"; audit = "report + draft, don't apply"; will switch to cloud env before starting.

**To execute:** in cloud session, run via superpowers:subagent-driven-development — dispatch parallel worktree-isolated subagents per workstream. Definition of Done + threshold-raise follow-up are in the plan. Relates to [[project_orchestration_handoff]].
