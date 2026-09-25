---
name: feedback_subagent_git_stash_hazard
description: "Parallel subagents in a SHARED git worktree can wipe each other's + your uncommitted work via git stash/checkout"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b524fd7a-4573-4efc-a572-d8c4166aa2a5
---

Never run 2+ background subagents that edit files in the SAME git worktree while you also have uncommitted changes there. Subagents share the worktree's single working tree, so if one runs `git stash` / `git checkout .` / `git restore` (e.g. "let me baseline-compare" or to clean up after a failing verify), it reverts EVERYONE's uncommitted changes at once — yours and the other agent's.

**Why:** This happened 2026-07-17 on the deposit-recognition retirement. An `impl` subagent ran `git stash` for a baseline comparison; it wiped all my in-flight lib edits + the other subagent's UI edits. Recovery worked only because `git stash apply stash@{0}` restored most of it, but two late edits were lost and had to be redone.

**How to apply:**
- Before spawning parallel file-editing subagents, either (a) commit your own work first so a stash/checkout can't touch it, or (b) don't spawn — do the cross-cutting edits inline.
- In subagent briefs, explicitly forbid `git stash`, `git checkout -- .`, `git restore`, `git reset` — tell them to fix-forward only and never revert the tree.
- Prefer `isolation: "worktree"` for parallel agents that mutate files, so each gets its own tree (per the Agent tool's isolation option).
- If a revert happens: `git stash list` + `git stash apply` (not pop) to recover; grep for your key markers to find edits the stash missed.

Related: [[feedback_subagent_worktree_cwd]] (subagent commits landing on the wrong branch).
