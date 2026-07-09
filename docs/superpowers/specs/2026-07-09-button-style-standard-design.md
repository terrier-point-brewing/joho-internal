# Button Style Standard — Design

**Date:** 2026-07-09
**Status:** Approved (brainstorm)
**Supersedes:** the 2026-06-29 ratified decision "primary button = solid amber" in `docs/UI_STANDARD.md`.

## Problem

Button style, color, and size are applied across the app without a consistent rule.
Examples the user cited:
- Recipes → `+ New Recipe` = solid amber **md** ("large").
- Inventory → `+ New Ingredient` = solid amber **xs** ("regular").
- Export Bay → `↻ Sync Taproom` / `+ Ad-Hoc Export` = **hollow, outlined** (and hand-rolled
  inline, not even using the shared primitives).
- Batch Log → solid amber buttons.

Root causes:
1. The ratified standard says **primary = solid amber**, but the look the team actually
   prefers is the Export Bay **outline** style — the standard and the preference diverged.
2. Two sizes (`md` default + `xs` modifier + `.btn-sm` alias) are used interchangeably with
   no rule, so "large vs regular" drift appears on near-identical screens.
3. The preferred outline buttons are hand-rolled inline (`border … rounded` boxes), so they
   were never governed by the primitive at all.

## Decision

**One compact, hollow button. Three tiers. No solid fills. No md size.**

The new primitive is exactly the Export Bay `+ Ad-Hoc Export` (primary) and `↻ Sync Taproom`
(secondary) look, promoted into `globals.css`.

### Tiers

| Class | Use | Border / text | Hover |
|---|---|---|---|
| `.btn-primary` | main action (New, Save, Run, Ship, Confirm) | `accent-border` + `text-accent` | amber wash `accent-muted/30`, text → `accent-soft` |
| `.btn-secondary` | cancel, close, secondary/neutral actions | `line-strong` + `text-secondary` | border → `line-subtle`, text → `body` |
| `.btn-danger` | destructive (Delete, Remove) | `danger-border` + `text-danger` | danger wash `danger-surface/40` |

Shared by all three: `padding: 0.25rem 0.625rem` (py-1 px-2.5), `font-size: 0.75rem`
(text-xs), `font-weight: 500`, `border-radius: 0.375rem`, `border: 1px solid`,
`background: transparent`. `:disabled → opacity 0.4; cursor not-allowed`.
`:focus-visible → 2px accent outline, offset 2px`.

**There is no size modifier and no solid variant.** Every action button is this one size and
one of these three tiers.

### globals.css (new definition, replaces the current button block)

```css
/* ── Buttons ──────────────────────────────────────────────────────────────
   One compact size, three hollow tiers. No solid fills, no size modifier.
   See docs/UI_STANDARD.md §5. */
.btn-primary,
.btn-secondary,
.btn-danger {
  padding: 0.25rem 0.625rem;   /* py-1 px-2.5 */
  font-size: 0.75rem;          /* text-xs */
  font-weight: 500;
  border-radius: 0.375rem;
  border: 1px solid transparent;
  background: transparent;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
  cursor: pointer;
}
.btn-primary   { border-color: var(--color-accent-border); color: var(--color-accent); }
.btn-primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-accent-muted) 30%, transparent);
  color: var(--color-accent-soft);
}
.btn-secondary { border-color: var(--color-line-strong); color: var(--color-text-secondary); }
.btn-secondary:hover:not(:disabled) {
  border-color: var(--color-line-subtle);
  color: var(--color-text-body);
}
.btn-danger    { border-color: var(--color-danger-border); color: var(--color-danger); }
.btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-danger-surface) 40%, transparent);
}
.btn-primary:disabled,
.btn-secondary:disabled,
.btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-primary:focus-visible,
.btn-secondary:focus-visible,
.btn-danger:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
```

The old `.btn-amber`, `.btn-ghost`, `.btn-sm`, `.btn-xs` classes are **removed**.

## Migration

### Class rename (mechanical, ~46 files)

| Old | New |
|---|---|
| `btn-amber` | `btn-primary` |
| `btn-ghost` | `btn-secondary` |
| `btn-sm` | `btn-secondary` |
| `btn-xs` | *(remove the token)* — e.g. `btn-amber btn-xs` → `btn-primary` |
| `btn-danger` | `btn-danger` (unchanged name; style changes with the new CSS) |

### Inline hand-rolled action buttons (~26 files, per-file judgment)

Bordered/filled `<button>` boxes that act as CTAs (e.g. Export Bay's inline
`text-xs px-3 py-1.5 …` Cancel, `border-accent-border …` Ad-Hoc Export) migrate to the
matching `.btn-*` tier. Map by role: amber-outline/primary CTA → `.btn-primary`,
neutral/cancel → `.btn-secondary`, destructive → `.btn-danger`.

### Out of scope (explicitly NOT converted)

These are different patterns, not CTA buttons — leave them:
- **Segmented / filter / toggle chips** (the `text-[11px] px-2 py-0.5 rounded border` pill
  rows and category selectors) — selection controls, governed separately.
- **Inline text-link actions** in table rows (`Edit` / `Delete` / `Adjust` / `Complete`
  rendered as `text-xs text-muted hover:…` text) — link-style affordances, not buttons.
- **Tab rows** (`SubNav` / `TabBar`).

## Documentation updates (part of this change)

1. `docs/UI_STANDARD.md`
   - §5 "Buttons" — replace the size×color matrix with the one-size three-tier table above.
   - §6 "Deprecated patterns" — update button rows to the new classes; add
     `solid amber / .btn-amber / .btn-ghost / .btn-sm / .btn-xs / md size → hollow .btn-*`.
   - The "Decisions ratified (2026-06-29)" banner — annotate that the solid-amber-primary
     decision is superseded by this standard (2026-07-09).
2. `CLAUDE.md` (project) — the UI Conventions bullet that lists
   `.btn-amber/.btn-ghost/.btn-danger/.btn-sm` updates to `.btn-primary/.btn-secondary/.btn-danger`
   with a one-line "hollow, compact, one size" description.
3. `AGENTS.md` — no button content today (Next.js-only note); add nothing unless a pointer is
   useful. Button guidance stays in CLAUDE.md → UI_STANDARD.md.

## Verification

- `npm run build` and `npm run lint` pass.
- `grep -rn "btn-amber\|btn-ghost\|btn-sm\|btn-xs" app` returns **0** (all renamed/removed).
- Spot-check the four cited screens (Recipes, Ingredients, Export Bay, Batch Log) in the
  preview: every action button is compact + outlined; primary = amber outline, cancel =
  neutral outline, destructive = danger outline.
- No solid-filled action buttons remain in feature code.

## Non-goals

- No React `<Button>` component (buttons stay CSS classes — matches current architecture).
- No change to filter chips, text-link table actions, tabs, inputs, or any non-button primitive.
- No new color tokens (reuses existing `accent-*`, `line-*`, `danger-*`).
