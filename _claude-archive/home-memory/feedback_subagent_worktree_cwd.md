---
name: feedback_subagent_worktree_cwd
description: Subagent git commands can leak to the main checkout/other branch; pin cwd + verify HEAD landed on our branch
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 774dc411-ca6f-42e5-bd93-436680d8c47c
---

When dispatching implementer/fix subagents from inside a git worktree, a subagent's `git add`/`git commit` can execute against the **main checkout** (or another worktree) instead of the intended worktree — the commit then lands on a *different branch* and never reaches ours. Observed 2026-07-09: a haiku fix subagent's commit (855f0b5) leaked onto `fix/batch-number-string-type` while our branch (`claude/button-style-standards-fdc289`) silently missed the fix. This repo has ~25 live worktrees and multiple concurrent Claude sessions, so the main checkout is often driven by another session — do NOT try to revert/rebase another branch to recover; re-apply the fix in your own worktree instead.

**Why:** subagent Bash cwd may not be the worktree; `git` resolves to whichever worktree the shell is in.

**How to apply:** (1) Tell subagents to `cd` into the exact worktree path before any git command, and pass an absolute worktree path. (2) As controller, after each subagent reports DONE, verify the commit actually landed: `git -C <worktree> log --oneline -1` shows the expected SHA/subject AND `git rev-parse HEAD` advanced. (3) If a commit is missing, don't chase it on other branches — re-apply directly in the worktree (surgical Edits are fine for a well-understood mechanical fix). See [[project_ui_consistency_pass]].
