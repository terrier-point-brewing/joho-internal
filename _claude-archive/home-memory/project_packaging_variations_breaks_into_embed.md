---
name: project_packaging_variations_breaks_into_embed
description: "Packaging Variations page broke twice over the self-referential breaks_into embed — PGRST200 + \"→ undefined\" pill; two non-obvious PostgREST/DB facts"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3909c564-bfe2-4239-b295-1b5012d78dd4
---

2026-07-16: The Recipes > Packaging Variations page (`app/production/components/PackagingVariationsPanel.tsx`, data via `PACKAGING_VARIATION_SELECT` in `lib/production/packagingVariations.ts`) broke twice in a row, both rooted in the self-referential `breaks_into` embed (`packaging_variations.breaks_into_variation_id` → `packaging_variations.id`, added by PR #202 / migration `20260801`). Fixed across PRs **#205** (crash) and **#206** (undefined pill), both squash-MERGED; worktree/branch cleaned up.

Two durable, non-obvious facts worth remembering before touching that embed again:

1. **The `breaks_into` FK in PROD has a NON-canonical constraint name.** The canonical `packaging_variations_breaks_into_variation_id_fkey` does NOT exist (verified: constraint-name embed → HTTP 400 PGRST200; column-name/no-hint embed → 200). Migration 20260801's inline `add column if not exists ... references ...` did not produce the canonical-named FK in prod (classic gotcha: `ADD COLUMN IF NOT EXISTS` skips the whole statement, incl. the inline FK, when the column already exists). The FK itself is fine; only its NAME is off. This is why the original constraint-name embed hint crashed the whole GET (PostgREST fails the entire select on one unresolvable embed).

2. **PostgREST resolves a self-referential embed to the REVERSE (to-many) direction** for both the column-name hint (`!breaks_into_variation_id`) and no hint — it returns an **array** (`"breaks_into": []`), not the single parent object. Truthy `[]` + `[].name === undefined` rendered a `→ undefined` pill on every row. Getting the forward to-one would require a constraint-name hint (fragile here — see #1).

**Resolution (final, in code):** dropped the self-referential embed entirely and resolve the break-down target's name client-side from the already-fully-loaded variations list via a name-by-id map. No extra query, no dependence on constraint name or self-ref direction. The scalar `breaks_into_variation_id` (from `*`) is untouched; only the panel ever read the embedded object. Prefer this pattern over self-ref PostgREST embeds. See [[project_migration_drift_brew_activities]] for the sibling "code shipped, migration/name drift on prod → PGRST error" pattern.

Domain note (still true): pack→loose break-down is auto/unambiguous (no setter by design); only `case`→pack is an explicit stored edge (`breaks_into_variation_id`, case-only constraint), settable in Add/Edit when Format=Case. Also fixed a UI nit: Keg type-filter chip looked always-on because `FilterChips` applies an option's category `className` unconditionally (Keg carried `KEG_TAG_BADGE`) — dropped the badge className.
