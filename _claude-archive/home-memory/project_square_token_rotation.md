---
name: project_square_token_rotation
description: 2026-07-11 — Square PROD access token was committed in git history via .claude/settings.local.json; file now untracked+gitignored but token still in history → ROTATION PENDING.
metadata: 
  node_type: memory
  type: project
  originSessionId: 363609f1-346c-4cb1-bd90-125fd9287d5f
---

2026-07-11 repo-hygiene cleanup (branch `claude/repo-hygiene-cleanup-e91ea3`) found a **live Square production access token** (`EAAAl_uG…`) committed inside `.claude/settings.local.json`'s `permissions.allow` curl rules.

Fixed in-tree: stripped the 6 token-bearing rules, `git rm --cached` the file, and gitignored `.claude/settings.local.json` (+ `.claude/worktrees/`, `.claire/`). MERGED to main via PR #168 (and independently by PR #167 agent-token-efficiency). Branch closed out.

**Still PENDING (user action, not done):** the token remains in git history — no history rewrite was performed (per constraint).
**Why:** anyone with repo history access can read the old token; it's compromised until rotated.
**How to apply:** (1) rotate/revoke in the Square Developer Dashboard; (2) update `SQUARE_ACCESS_TOKEN` in `.env.local` AND Vercel project settings. Do NOT attempt filter-repo history rewrite without explicit sign-off.

Related: worktree hygiene rule added to CLAUDE.md; ~3.9 GB reclaimed by deleting node_modules in stale `.claude/worktrees/` (all worktrees held unmerged work, so none of the worktrees themselves were deleted except merged `charming-swartz`).
