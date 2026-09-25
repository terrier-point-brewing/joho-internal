# Task: Repo hygiene — prune stale agent artifacts + context-efficiency fixes

Work through the phases in order. Do NOT start Phase 2 until Phase 1's safety checks are done. Never delete anything that has uncommitted changes or unmerged commits without listing it and asking me first.

## Phase 1 — Prune stale agent worktrees (~7 GB)

There are ~17 worktrees under `.claude/worktrees/`, most stale, 12 with their own `node_modules`. Some were touched recently and may hold unmerged work.

For EACH directory in `.claude/worktrees/*/`:
1. Run `git -C <dir> status --porcelain`. If dirty → add to a "needs review" list, skip deletion.
2. Determine its branch (`git -C <dir> branch --show-current`). If it has commits not in `main` (`git log main..<branch> --oneline`) → add to "needs review" list, skip.
3. Detached-HEAD worktrees: check `git -C <dir> log main..HEAD --oneline`; unmerged commits → "needs review", skip.
4. Otherwise: `git worktree remove <dir> --force` (fall back to `rm -rf` + `git worktree prune` if git refuses).

Then:
- Remove `.claire/` (contains one orphaned worktree fragment) and `.worktrees/naughty-black-cdee28` if empty/stale, same safety checks.
- Run `git worktree prune` and confirm `git worktree list` shows only the main worktree plus anything on the needs-review list.
- Print the needs-review list with branch names and dirty-file counts, and total disk space reclaimed.

## Phase 2 — Stale branch cleanup

- Delete all local `claude/*` and `backup/*` branches fully merged into `main` (`git branch --merged main`).
- List unmerged `claude/*` branches with last-commit date; do NOT delete them, just report.

## Phase 3 — Security: committed Square access token

`.claude/settings.local.json` is tracked in git and its `permissions.allow` list contains a live Square production access token embedded in old curl rules.

1. Rewrite the file: remove every allow rule containing `Authorization: Bearer` / the token. Keep the generic rules (`npm run *`, `npx tsc *`, MCP tool allows, etc.).
2. `git rm --cached .claude/settings.local.json` and add `.claude/settings.local.json` to `.gitignore`.
3. Commit. Then print a clear reminder for me: **the token is still in git history — I must rotate it in the Square developer dashboard and update `SQUARE_ACCESS_TOKEN` in `.env.local` and Vercel project settings.** Do not attempt history rewriting (filter-repo) yourself.

## Phase 4 — Search-pollution fixes (.gitignore)

Add to `.gitignore` so ripgrep/Grep skip them in future sessions:
```
.claude/worktrees/
.claire/
```
(`.superpowers/` and `.worktrees/` are already ignored.)

## Phase 5 — Archive completed superpowers docs

- Create `docs/superpowers/archive/plans/`.
- For each file in `docs/superpowers/plans/`: if the feature it describes has shipped (check `git log --oneline` for matching merge commits/PR titles), move it to the archive dir. If unsure, leave it in place and note it.
- Move `docs/superpowers/2026-06-28-orchestration-handoff.md` to archive if that batch is complete.
- Delete the contents of `.superpowers/sdd/` (gitignored scratch: task briefs, review diffs, progress files).
- Do NOT touch: `docs/UI_STANDARD.md`, `docs/production-schema.md`, `docs/batch-backfill-guide.md`, `docs/audits/`, `docs/ui/`.

## Phase 6 — CLAUDE.md hygiene rule (only change to CLAUDE.md)

Do not rewrite CLAUDE.md. Append one short section:

```
## Worktree Hygiene
After a worktree's branch is merged, remove the worktree (`git worktree remove <dir>`) and delete its merged branch. Never leave worktrees with node_modules under `.claude/worktrees/` — they pollute search and disk.
```

## Phase 7 — Verify

1. `git worktree list` — only main + explicitly-skipped entries.
2. `du -sh .claude` — should be a few MB, not GB.
3. `rg -l "GALLONS_PER_BBL"` from repo root — hits only in the main tree, no `.claude/worktrees/` paths.
4. `git ls-files | grep settings.local` — empty.
5. `npm run build` passes.
6. Commit everything as one or two clean commits with descriptive messages; show me the final diff summary and the needs-review lists before finishing.

## Hard constraints
- No changes to app code, `lib/`, `supabase/migrations/`, or CI config.
- No force-pushes, no history rewrites, no remote branch deletion.
- Anything ambiguous → report, don't act.
