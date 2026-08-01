#!/usr/bin/env bash
# Give a git worktree the .env.local it can never inherit.
#
# .env.local is gitignored, and `git worktree add` only materializes TRACKED
# files. So every new worktree starts without one, the Next middleware throws
# `Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL`, and every
# route 500s — including the ones that look static. `npm run build` fails the
# same way at the prerender step, after compile and TypeScript have passed,
# which makes it read like a code failure when it is a setup one.
#
# Wired as a SessionStart hook so it runs before anyone notices. Symlinks
# rather than copies: rotate a key in the main checkout and every worktree
# follows, instead of N stale copies drifting apart.
#
# Safety properties, in order of how much they matter:
#   * Never reads or prints the file's contents. It only ever links a path.
#   * Never overwrites. An existing .env.local in the worktree — real file or
#     link — is left exactly as it is.
#   * Never touches the main checkout. That is where the real file lives.
#   * Always exits 0. A hook that can fail a session start is worse than a
#     missing env file.

set -uo pipefail

# Not a git repo (or git is unavailable) — nothing to reason about.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

worktree_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -n "$worktree_root" ] || exit 0

# --git-common-dir resolves to the PRIMARY repo's .git even from a linked
# worktree, which is what makes the main checkout findable from in here.
common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
[ -n "$common_dir" ] || exit 0
main_root="$(dirname "$common_dir")"

# In the main checkout itself there is nothing to do.
if [ "$worktree_root" = "$main_root" ]; then
  exit 0
fi

src="$main_root/.env.local"
dst="$worktree_root/.env.local"

# No source to link, or something is already there. Either way, hands off.
if [ ! -f "$src" ]; then
  exit 0
fi
if [ -e "$dst" ] || [ -L "$dst" ]; then
  exit 0
fi

if ln -s "$src" "$dst" 2>/dev/null; then
  echo "Linked .env.local from the main checkout (worktrees do not inherit gitignored files)."
elif cp "$src" "$dst" 2>/dev/null; then
  # Filesystems that refuse symlinks still get a working worktree; the copy is
  # a point-in-time snapshot, so a later key rotation will not reach it.
  chmod 600 "$dst" 2>/dev/null || true
  echo "Copied .env.local from the main checkout (symlink unavailable on this filesystem)."
fi

exit 0
