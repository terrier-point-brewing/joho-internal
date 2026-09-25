# Claude Code pre-zero-base archive

Snapshot taken 2026-07-31, immediately before the `chore: zero-base Claude Code
memory and config` commit on `main`. Preserved here so the removed state stays
recoverable from GitHub. This branch is **not** intended to be merged.

| Directory | Source | Contents |
|---|---|---|
| `home-memory/` | `~/.claude/projects/-Users-will-liao-Desktop-Coding-Git-tpb-square-reports/memory/` | 93 files — `MEMORY.md` index + 12 `feedback_*` + 80 `project_*` |
| `home-skills/` | `~/.claude/skills/` | 10 personal skills, symlinks dereferenced to real content |
| `repo-local/` | `.claude/settings.local.json` | gitignored, added with `git add -f` |
| `repo-untracked/` | repo root | `cleanup-prompt.md`, `backups/` (3 CSV table snapshots, 2026-06-26) |

Repo files deleted by the zero-base commit (`CLAUDE.md`, `AGENTS.md`,
`.claude/agents/impl.md`, `.claude/hooks/*.js`, `docs/agent-context.md`,
`docs/agent-token-efficiency.md`) are **not** duplicated here — they are already
present in this branch's tree, which is `main` at 61f7a9e.

`~/.claude/CLAUDE.md` and `~/.claude/RTK.md` were deliberately left untouched and
are not archived. `CLAUDE.local.md`, `.claude/rules/`, `.claude/skills/`, and
`.mcp.json` never existed in this repo.
