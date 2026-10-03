---
name: project_text_ramp_utilities_tailwind_v4
description: "Tailwind v4 silently emits nothing for `text-secondary`/`text-muted`/etc because --color-text-* names collide with the text- prefix; fixed by explicit @utility rules in globals.css (PR #273)"
metadata: 
  node_type: memory
  type: project
  originSessionId: a831bb76-fa45-4d67-909a-71bde3149752
  modified: 2026-07-25T16:10:43.582Z
---

2026-07-25 (PR #273, MERGED as squash 94e2114, no migration): the entire ops text
ramp was **inert app-wide** — 2310 usages of
`text-primary/strong/body/secondary/muted/faint/disabled` emitted no CSS at all.

**Root cause (durable Tailwind v4 gotcha):** v4 derives a color's NAME from
`--color-<name>`, so `--color-text-secondary` registers a color literally named
`text-secondary`. Reachable through `bg-`/`border-` (`bg-text-secondary` — really
used at `app/taproom/components/SalesPulseTab.tsx:341`), but through the `text-`
prefix it would have to be written `text-text-secondary`. The short form
documented in `docs/UI_STANDARD.md` §3 resolves a nonexistent `--color-secondary`
and emits NOTHING. No error, no warning — the class just does nothing.

Everything fell through to the inherited body color. Measured live pre-fix:
`text-muted` == `text-primary` == `text-secondary` == `rgb(230,232,240)`.
Because that fallback is an inherited literal, not a token lookup, the text also
could not follow the light/brand skin — the visible symptom that started this.

**Fix:** seven explicit `@utility text-primary { color: var(--color-text-primary); }`
declarations near the top of `app/globals.css` (top-level, NOT inside
`@layer components`). Bind to `var(--color-*)`, never the raw hex, so BrandChrome
overrides still apply.

**How to detect this class of bug:** a token utility that renders the inherited
color is dead. Verify by computed style in the browser, not by reading source —
`npm run verify` and the no-raw-colors grep guard both pass happily on dead
classes. Grepping the built CSS for `.text-secondary` also works (0 matches = dead).

⚠️ **Blast radius:** the fix is app-wide. Every page gained the text hierarchy it
was always written for, so secondary/muted text that had rendered near-white
visibly stepped down everywhere. Intended per UI_STANDARD §3, but nothing was
visually re-checked page-by-page — the four screens in the PR are login-gated and
were never exercised in a browser. If someone reports "text got dimmer" after
2026-07-25, this is why.

Same PR also tokenized four surfaces: Draft States retire button sized to
`btn-secondary btn-xxs` (matches Swap keg), Gantt/timeline chrome, Transfers Type
pills (deduped onto the existing `TRANSFER_TYPE_BADGE` in
`app/production/lib/categoryColors.ts`), and finance Export/QuickBooks invoice
pills onto `--cat-teal-*`/`--cat-violet-*`. See [[project_light_mode_contrast_brand_skin]]
for the `--cat-{hue}-*` token system and [[project_ui_consistency_pass]] for the
raw-color standard.
