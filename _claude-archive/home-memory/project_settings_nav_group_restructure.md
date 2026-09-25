---
name: project-settings-nav-group-restructure
description: "PR #287 (merged 2026-07-28) moved settings nav into the sidebar as 7 scope-aligned groups; merged WITHOUT visual verification, and MappingGrid's max-h magic number is now mistuned."
metadata: 
  node_type: memory
  type: project
  originSessionId: 62ed581e-4f65-44c8-8e7d-de998b13451f
  modified: 2026-07-29T02:13:58.119Z
---

2026-07-28, **PR #287 MERGED** (squash `7d8d5c2`), no migrations. Settings dropped
its own 11-tab row; the group row now lives in the app sidebar (+ a `md:hidden`
SubNav on mobile) and each group has exactly ONE level of subtabs — the same
shape production/taproom already used, and what `docs/UI_STANDARD.md` §4 always
specified. Seven groups, one per scope family: User (scope-less), Environment
(`org.*`), Finance, Payroll, Tax, Production, Catalog. Routes are uniformly
`/settings/<group>/<leaf>`; old `/settings/account`-style URLs 404, no stubs.

⚠️ **Open follow-ups (merged anyway, both cosmetic):**

1. **Never visually verified.** `npm run verify` was clean and all 14 routes
   resolved, but the dev preview sits behind the login wall and I don't enter
   credentials. Nobody has confirmed the padding/alignment on screen at desktop
   or mobile width.
2. `app/settings/catalog/MappingGrid.tsx:198` still has
   `max-h-[calc(100vh-140px)]`, tuned to the old two-row chrome. One row is
   gone, so the grid renders shorter than it could. Left alone rather than
   guessed at.

**Why:** both need eyes on a running app, which this session couldn't get.

**How to apply:** when next signed in, walk the seven groups at desktop + mobile
and re-tune that `140px` against the real chrome height.

Durable: `NavEntry` gained `requiresAny` + a shared `navEntryVisible()` helper —
the Environment group spans three unrelated scopes (`org.business`,
`org.users`, `org.jobs`), so no single capability covers it. Reach for that
before special-casing group visibility in one renderer. Also confirmed again
that squash-merge strands the local SHA (see [[project_invoice_packaging_materials_charge]]):
`97cfeac` never appeared on any remote branch, `7d8d5c2` did.
