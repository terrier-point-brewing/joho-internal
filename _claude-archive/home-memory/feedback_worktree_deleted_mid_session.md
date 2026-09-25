---
name: feedback-worktree-deleted-mid-session
description: "A concurrent session's worktree cleanup deleted this session's active worktree AND its branch mid-task — check before assuming your own commands caused it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: abc24b1b-a4fd-4815-a6f3-9aba276e2dd9
  modified: 2026-07-29T02:22:40.439Z
---

2026-07-28: mid-task, `.claude/worktrees/unknown-draft-recounts-c29257/` was
emptied (only the untracked `.next/` survived), it vanished from
`git worktree list`, and the branch `claude/unknown-draft-recounts-c29257` was
deleted too. No destructive command had been run in this session. Most likely a
concurrent session running the CLAUDE.md "Worktree Hygiene" step (an untracked
`cleanup-prompt.md` was sitting in the main repo).

**Why:** parallel sessions share one repo. A cleanup that prunes "merged"
worktrees can't see that another session is mid-task in one, and it takes the
branch with it — so uncommitted work is unrecoverable, not just misplaced.

**How to apply:** commit early and often on a worktree branch; uncommitted work
has no backstop. If files vanish, check `git worktree list` and
`git branch --list` before assuming your own tooling did it. Recover with
`rm -rf <dir> && git worktree prune && git worktree add <dir> -b <branch> main`.
Then re-do the CLAUDE.md worktree setup — note `ln -sf` for `.env.local` may be
denied by the permission classifier on the second attempt even though it
succeeded at session start, which blocks `npm run dev` and `npm run build`
(prerender needs `NEXT_PUBLIC_SUPABASE_URL`). `npm install` may be denied too.
Ask the user to run those rather than working around the denial. See
[[feedback_subagent_git_stash_hazard]].
