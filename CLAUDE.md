# Browser-based visual verification

This app requires sign-in ([app/login/page.tsx](app/login/page.tsx), Supabase email/password auth) before most pages render, which makes verifying UI changes in a browser painful across sessions.

- **Prefer Claude in Chrome (`mcp__claude-in-chrome__*`) over the Browser pane (`mcp__Claude_Browser__*`) for logging into and visually checking this app.** The Browser pane is an isolated context per session, so each session has to log in separately. Claude in Chrome drives the user's real Chrome browser — a single shared instance — so once one session is signed in, every other session inherits that session/cookies. Use the Browser pane only when Claude in Chrome isn't available or the task specifically needs an isolated context.
- If a login prompt does need to be filled (e.g. a fresh Chrome profile, or the session has been logged out), use the `APP_USERNAME` and `APP_PASSWORD` values from `.env.local` — a Supabase account created specifically for Claude Code testing. Read them from the env file at the moment they're needed; never hardcode them in code, comments, or docs, and never paste the values into chat.
- If multiple sessions drive Claude in Chrome at the same time, open a new tab per session (`tabs_create_mcp`) rather than reusing one — navigation can still collide even though login state is shared.
- Always close out the tabs/tab groups you opened in Claude in Chrome once a visual check is done (`tabs_close_mcp`) — since it's the shared browser, leftover tabs pile up and clutter the next session.

# "Let's close out"

When the user says "let's close out" (or similar), it means: complete every step below that isn't already done. Don't stop partway and wait for confirmation — run the whole sequence.

1. Commit the outstanding changes and open a PR against `main`.
2. Merge the PR into `main` (wait for CI to go green first).
3. Apply any necessary Supabase migrations — before or after the merge, whichever order the change actually requires.
4. Close any Chrome tabs this session opened (`tabs_close_mcp`).
5. Give a short, non-technical summary: what was implemented, plus any follow-up actions that still need a human.
6. Prune the worktree(s) used for this session and archive the session.
