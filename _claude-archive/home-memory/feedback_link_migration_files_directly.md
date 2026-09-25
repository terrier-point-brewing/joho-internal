---
name: feedback_link_migration_files_directly
description: "Always give a direct clickable path link to a new migration file, every time — the user applies them by hand"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e49d81a1-294a-41a5-9d88-81d47b414a19
  modified: 2026-07-30T21:10:42.815Z
---

Whenever a migration is authored, hand over a **direct markdown path link to the
`.sql` file** alongside the apply command. Every time, unprompted — not only when
asked, and not only for the first migration in a batch.

**Why:** the user applies migrations by hand against production. A migration that
is described but not linked costs them a hunt through
`supabase/migrations/`, and that is worse when the file lives in a git worktree
under `.claude/worktrees/<name>/` rather than the main checkout. Stated as a
standing preference on 2026-07-30 after PR #302, having also come up when PR
#300's migration was renamed and the path silently changed under them.

**How to apply:**
- Link the file: `[20260905090000_fix_coa_reference_count.sql](supabase/migrations/…)`
- Send it with SendUserFile too when it is the deliverable of the turn.
- If the migration is in a worktree, give the path that resolves from wherever
  they will actually open it, and say which worktree it is in.
- **If a migration's filename changes** (e.g. re-stamped after a version
  collision — see [[project_draft_swap_tap_transitions]]), say so explicitly and
  re-link, because a previously-sent path goes stale.

Related: [[feedback_prod_db_migration_authorization]] (never apply migrations on
their behalf; orchestrator hands over, user applies).
