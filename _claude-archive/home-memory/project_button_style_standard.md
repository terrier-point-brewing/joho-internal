---
name: project_button_style_standard
description: "App-wide button standard — one compact hollow tier (.btn-primary/.btn-secondary/.btn-danger), supersedes solid-amber"
metadata: 
  node_type: memory
  type: project
  originSessionId: 774dc411-ca6f-42e5-bd93-436680d8c47c
---

**Established & MERGED 2026-07-09** via **PR #141** (squash) from branch `claude/button-style-standards-fdc289`. Merged main back in first (resolved stale ramp commit to main's version; fixed one reintroduced `btn-ghost btn-xs` in the new `FilterBar.tsx`). Supersedes the 2026-06-29 "primary = solid amber" decision from [[project_ui_consistency_pass]].

**Follow-up (PR #145, 2026-07-09):** compact was too big for dense contexts → added `.btn-xxs` size modifier (`py-0.5 px-1.5`, 10px; composes as `btn-primary btn-xxs`), applied to BrewStatus tank tiles + BatchLog invoice-action row. Dense inline/tile contexts ONLY — documented as not-a-general-small-button.

**The standard:** ONE compact default size, three hollow (outline) tiers, no solid fills; only size modifier is `.btn-xxs` (dense contexts only). All `py-1 px-2.5 text-xs`, transparent bg, 1px border, `disabled → opacity 0.4`, focus-visible amber outline.
- `.btn-primary` — amber outline (`border-accent-border` + `text-accent`): main action.
- `.btn-secondary` — neutral outline (`border-line-strong` + `text-secondary`): cancel/close/secondary.
- `.btn-danger` — danger outline: destructive.
Removed: `.btn-amber`, `.btn-ghost`, `.btn-sm`, `.btn-xs`, and the md size.

**Rules learned / gotchas:**
- Each button = exactly ONE tier class. `btn-sm` was a standalone tier, so `btn-amber btn-sm` combos renamed into dual-tier `btn-primary btn-secondary` — collapse to one.
- No success/info button tier: green/blue ACTION buttons fold into `.btn-secondary` (or `.btn-primary` if the main action). But STATUS/state-encoding toggles & badges (color = active/inactive/has-split via a `${cond ? ... : ...}` className) are NOT buttons — leave them; a naive success/info sweep wrongly flattened several and had to be restored.
- Watch leftover `text-sm`/padding/`disabled:opacity-*` utilities riding alongside a tier class — they override the primitive so the button never shrinks to compact. Grep: `grep -rnE 'btn-(primary|secondary|danger)' app --include=*.tsx | grep -E 'text-(sm|base|lg)|disabled:opacity'`.
- Out of scope (kept as-is): filter/segmented/toggle chips, inline text-link table actions (Edit/Delete as colored text), tabs (SubNav/TabBar).

**Docs updated:** `docs/UI_STANDARD.md` §5/§6/§2 + superseded banner, `CLAUDE.md` UI Conventions bullet. Spec: `docs/superpowers/specs/2026-07-09-button-style-standard-design.md`; plan: `docs/superpowers/plans/2026-07-09-button-style-standard.md`.

**Caveat:** feature screens need login (unavailable to agents), so dense buttons (BrewStatus keg tiles, BatchLog invoice-action row) were converted per the standard but NOT visually verified for overflow — worth a manual spot-check. See [[feedback_subagent_worktree_cwd]] for the stray-commit incident during this build.
