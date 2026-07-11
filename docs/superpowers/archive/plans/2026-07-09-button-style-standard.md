# Button Style Standard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ad-hoc button styles (solid amber, mixed md/xs sizes, hand-rolled outline boxes) with one standard: a single compact, hollow, three-tier button primitive applied app-wide.

**Architecture:** Buttons are pure CSS classes in `app/globals.css` (no React `<Button>` component). We redefine the primitives to a hollow compact look, rename `.btn-amber/.btn-ghost/.btn-sm/.btn-xs` → `.btn-primary/.btn-secondary` (`.btn-danger` keeps its name), convert the few inline hand-rolled CTA buttons to the primitives, then update the standard docs. No logic changes — purely presentational.

**Tech Stack:** Next.js 16 App Router, Tailwind v4 (`@theme` tokens), CSS `@layer components` primitives.

## Global Constraints

- **Design source:** `docs/superpowers/specs/2026-07-09-button-style-standard-design.md`. Every rule below traces to it.
- **One size only:** `padding: 0.25rem 0.625rem` (py-1 px-2.5), `font-size: 0.75rem` (text-xs), `font-weight: 500`. No md tier, no size modifier.
- **Three hollow tiers:** `.btn-primary` (amber outline), `.btn-secondary` (neutral outline), `.btn-danger` (danger outline). Transparent fill, 1px border. No solid fills anywhere.
- **No raw colors:** use existing tokens only (`--color-accent`, `--color-accent-border`, `--color-accent-soft`, `--color-accent-muted`, `--color-line-strong`, `--color-line-subtle`, `--color-text-secondary`, `--color-text-body`, `--color-danger`, `--color-danger-border`, `--color-danger-surface`). No new tokens.
- **Out of scope (do NOT touch):** filter/toggle/segmented chips, inline text-link table actions (`Edit`/`Delete`/`Adjust`/`Complete` as colored text), `SubNav`/`TabBar`, inputs, info boxes/badges/progress bars that merely share `border-accent-border`.
- **Verify each task:** `npm run dev` is used for visual checks via the preview tools; `npm run build` and `npm run lint` must pass before every commit.
- Commit after each task. Branch is already `claude/button-style-standards-fdc289` (worktree).

---

### Task 1: Redefine button primitives in globals.css

Add the new hollow classes and redefine `.btn-danger`. Keep the old `.btn-amber/.btn-ghost/.btn-sm/.btn-xs` classes in place **for now** so the app keeps rendering during the rename (they are removed in Task 3).

**Files:**
- Modify: `app/globals.css` (the `@layer components` button block, currently lines ~68-140)

**Interfaces:**
- Produces: CSS classes `.btn-primary`, `.btn-secondary`, `.btn-danger` (hollow, compact) consumed by Tasks 2 & 4.

- [ ] **Step 1: Add the three new tier classes**

Insert this block immediately after the `/* ── Button tiers ── */` comment (before `.btn-amber`), and replace the existing `.btn-danger` rules with the version below:

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
.btn-danger    { border-color: var(--color-danger-border); color: var(--color-danger); background: transparent; }
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

Delete the previous `.btn-danger { … }` / `.btn-danger:hover` / `.btn-danger:disabled` / `.btn-danger:focus-visible` rules (now superseded by the block above). **Leave `.btn-amber`, `.btn-ghost`, `.btn-sm`, `.btn-xs` untouched in this task.**

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: build succeeds (CSS compiles; `color-mix` and tokens resolve).

- [ ] **Step 3: Visual smoke check**

Start the dev server (preview_start) and open a screen with a `.btn-danger` button (e.g. a modal with a destructive action). Confirm it now renders as a hollow danger-outline button (transparent fill, red border/text). `.btn-amber`/`.btn-ghost` still render old (solid/ghost) — expected until Task 2.

- [ ] **Step 4: Commit**

```bash
git add app/globals.css
git commit -m "feat(ui): add hollow .btn-primary/.btn-secondary tiers + hollow .btn-danger"
```

---

### Task 2: Rename primitive usages across feature files

Mechanical class-name swap in all `.tsx` feature files. `.btn-danger` name is unchanged (its style already changed in Task 1).

**Files:**
- Modify: every `app/**/*.tsx` using `btn-amber`/`btn-ghost`/`btn-sm`/`btn-xs` (~46 files; full list in the design scan). Do **not** modify `app/globals.css` in this task.

**Interfaces:**
- Consumes: `.btn-primary`/`.btn-secondary` from Task 1.

- [ ] **Step 1: Run the rename**

Run (from repo root of the worktree):

```bash
FILES=$(grep -rl 'btn-amber\|btn-ghost\|btn-sm\|btn-xs' app --include="*.tsx")
for f in $FILES; do
  sed -i '' \
    -e 's/btn-amber/btn-primary/g' \
    -e 's/btn-ghost/btn-secondary/g' \
    -e 's/btn-sm/btn-secondary/g' \
    -e 's/ btn-xs//g' \
    -e 's/btn-xs //g' \
    -e 's/btn-xs//g' \
    "$f"
done
```

Note: the three `btn-xs` substitutions strip the modifier whether it's leading, trailing, or standalone; a leftover double-space inside a `className` string is inert. `btn-secondary` contains no `btn-sm` substring, so ordering is safe.

- [ ] **Step 2: Verify no old names remain in feature code**

Run: `grep -rn 'btn-amber\|btn-ghost\|btn-sm\|btn-xs' app --include="*.tsx"`
Expected: **no output** (0 matches).

- [ ] **Step 3: Build + lint**

Run: `npm run build && npm run lint`
Expected: both pass.

- [ ] **Step 4: Visual check on the four cited screens**

Preview Recipes, Ingredients, Export Bay, Batch Log. Every primitive button is now compact + outlined: primary = amber outline, secondary/cancel = neutral outline. No solid fills remain from the primitives.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(ui): rename btn-amber/ghost/sm/xs -> btn-primary/secondary; drop size modifier"
```

---

### Task 3: Remove dead old primitive definitions

**Files:**
- Modify: `app/globals.css`

- [ ] **Step 1: Delete the old classes**

Remove the `.btn-amber`, `.btn-amber:hover/:disabled/:focus-visible`, `.btn-ghost` (+states), `.btn-sm` (+states), and `.btn-xs` rule blocks and their preceding stale comments (`/* md (default) … */`, `/* sm tier … */`, `/* xs size modifier … */`). Keep only the new `.btn-primary/.btn-secondary/.btn-danger` block from Task 1.

- [ ] **Step 2: Verify old classes are gone everywhere**

Run: `grep -rn 'btn-amber\|btn-ghost\|btn-sm\|btn-xs' app`
Expected: **no output** (0 matches, including globals.css).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add app/globals.css
git commit -m "refactor(ui): remove superseded .btn-amber/.btn-ghost/.btn-sm/.btn-xs"
```

---

### Task 4: Convert inline hand-rolled CTA buttons to primitives

Replace the handful of inline `<button>` CTAs with the matching primitive. **Only convert real action `<button>` elements.** Skip anything that is an info box, badge, segmented toggle, progress bar, or a text-link table action.

**Detection rule per `<button>`:**
- Amber-outline CTA (`border-accent-border` / `text-accent(-emphasis)` + `rounded`, e.g. `+ Ad-Hoc Export`) → replace the whole `className` with `btn-primary` (keep any layout-only utilities like `ml-auto`, `shrink-0`, `w-full`).
- Neutral cancel/close CTA (`px-3 py-1.5 text-secondary hover:text-strong`, or `text-xs px-2.5 py-1 border border-line-strong`, e.g. `Cancel`, `↻ Sync Taproom`) → replace `className` with `btn-secondary`.
- Danger CTA (`border-danger-border`/`text-danger` bordered `<button>`) → `btn-danger`.
- Preserve `type`, `onClick`, `disabled`, `title`, and layout-only classes; drop the now-redundant color/border/padding/size utilities.

**Files & concrete targets** (identify by label/purpose — line numbers drift after Tasks 2-3):

- Modify: `app/production/components/ExportBayTab.tsx`
  - `+ Ad-Hoc Export` (amber outline) → `btn-primary`
  - `↻ Sync Taproom` (neutral outline) → `btn-secondary`
  - the four modal `Cancel`/`Close` buttons (`text-xs px-3 py-1.5 text-secondary hover:text-strong`) → `btn-secondary`
  - the inline amber-outline CTA in the row-expansion (`text-xs px-2.5 py-1 border border-accent-border …`) → `btn-primary`
- Modify: `app/production/components/ShipmentsTab.tsx`
  - `clearSelection` button (`px-3 py-1.5 text-secondary hover:text-strong`) → `btn-secondary`
- Modify: `app/production/components/TransferModal.tsx`
  - the amber-outline action button (`text-xs text-accent-emphasis … border border-accent-border px-2 py-1 rounded`, ~line 537) → `btn-primary`. **Do NOT touch** the mode/target/volume segmented toggles in this file (those are selection controls — out of scope).
- Modify: `app/production/components/BrewStatusTab.tsx`
  - the normal-flow amber-outline CTAs (`text-xs … border border-accent-border … px-3 py-1.5 rounded`, ~lines 590/601/627) → `btn-primary`
  - the dense keg-tile CTAs (`w-full … border border-accent-border … px-1.5 rounded`, ~lines 887/1020/1054): convert to `btn-primary w-full`, **then visually verify the keg tiles don't overflow**. If a tile clips, leave that specific button inline and note it in the task's completion summary (dense floorplan-adjacent context).
- Modify: `app/production/components/BatchLogTab.tsx`
  - the dense inline amber-outline CTAs (`text-[10px] … border border-accent-border/50 … px-1.5 py-1 rounded`, ~lines 956/965): convert to `btn-primary`, **then visually verify** the inline row doesn't overflow; if it clips, leave inline and note it.

- [ ] **Step 1: Convert the clear-cut CTAs** (ExportBayTab, ShipmentsTab, TransferModal, BrewStatusTab normal-flow) per the rule above.

- [ ] **Step 2: Convert the dense CTAs** (BrewStatusTab keg tiles, BatchLogTab inline), one at a time.

- [ ] **Step 3: Build + lint**

Run: `npm run build && npm run lint`
Expected: both pass.

- [ ] **Step 4: Visual verification**

Preview Export Bay (toolbar + modals), Shipments (selection toolbar), a Transfer modal, Brew Status (keg tiles), Batch Log (inline actions). Confirm: converted buttons are compact hollow primitives; nothing overflows; any button left inline for overflow reasons is noted.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(ui): migrate inline hand-rolled CTA buttons to .btn-* primitives"
```

---

### Task 5: Update standard + agent-instruction docs

Bring the written standard in line with the shipped code.

**Files:**
- Modify: `docs/UI_STANDARD.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Rewrite `docs/UI_STANDARD.md` §5 "Buttons"**

Replace the size×color matrix and the "Single primary = amber / `.btn-amber` is the ratified solid style" paragraphs with:

```markdown
### Buttons (`globals.css`)
One compact size, three hollow tiers. **No solid fills, no size modifier.** Every action
button is `py-1 px-2.5 text-xs font-medium`, transparent fill, 1px outline.

| Class | Style | Use |
|---|---|---|
| `.btn-primary` | amber outline — `border-accent-border text-accent`, hover amber wash + `text-accent-soft` | the main action (New, Save, Run, Ship, Confirm) |
| `.btn-secondary` | neutral outline — `border-line-strong text-secondary`, hover `border-line-subtle`/`text-body` | cancel, close, secondary/neutral actions |
| `.btn-danger` | danger outline — `border-danger-border text-danger`, hover danger wash | destructive (Delete, Remove) |

All share `:disabled → opacity-40`, `:focus-visible → 2px accent outline`. There is **no
`.btn-amber`/`.btn-ghost`/`.btn-sm`/`.btn-xs` and no md size** — do not hand-roll bordered or
filled `<button>` boxes; use a tier class. Filter/toggle chips, inline text-link table
actions (`Edit`/`Delete` as text), and tabs are separate patterns, not buttons.
```

- [ ] **Step 2: Update `docs/UI_STANDARD.md` §6 deprecated-patterns table**

Change the two button rows to:

```markdown
| Solid amber / any inline bordered-or-filled `<button>` CTA; `.btn-amber`/`.btn-ghost`/`.btn-sm`/`.btn-xs`; md size | `.btn-primary` (amber outline) / `.btn-secondary` (neutral) / `.btn-danger` — one compact size |
```

- [ ] **Step 3: Supersede the ratified banner**

In the "Decisions ratified (2026-06-29)" blockquote near the top, append:

```markdown
> **Superseded 2026-07-09:** the "primary button = solid amber" decision is replaced by the
> one-compact-hollow-button standard (`.btn-primary`/`.btn-secondary`/`.btn-danger`, outline
> only, no solid fill, no md size). See §5 and
> `docs/superpowers/specs/2026-07-09-button-style-standard-design.md`.
```

- [ ] **Step 4: Update `CLAUDE.md` UI Conventions**

In the "No hand-rolled primitives" bullet, change:

`Buttons → .btn-amber/.btn-ghost/.btn-danger/.btn-sm.`

to:

`Buttons → .btn-primary/.btn-secondary/.btn-danger — one compact hollow (outline) tier, no solid fills, no size modifier; never hand-roll a bordered/filled <button>.`

- [ ] **Step 5: Sanity grep**

Run: `grep -rn 'btn-amber\|btn-ghost\|btn-sm\b\|btn-xs' docs CLAUDE.md`
Expected: matches only in the deprecated-patterns row / superseded banner (as historical references), nowhere as a live recommendation.

- [ ] **Step 6: Commit**

```bash
git add docs/UI_STANDARD.md CLAUDE.md
git commit -m "docs(ui): standard = one compact hollow button (supersede solid-amber)"
```

---

## Self-Review

- **Spec coverage:** primitives redefined (T1), all usages renamed (T2), old classes removed (T3), inline CTAs converted (T4), docs incl. agent instructions updated (T5). Verification (build/lint/grep/visual) is in each task. ✔ Covers every section of the design.
- **Placeholder scan:** exact CSS, exact sed, exact grep, concrete file+target list. Dense-button overflow is an explicit conditional (convert-and-verify, flag if it clips), not a vague "handle edge cases". ✔
- **Type/name consistency:** `.btn-primary`/`.btn-secondary`/`.btn-danger` used identically across T1-T5; rename map (`btn-amber→btn-primary`, `btn-ghost→btn-secondary`, `btn-sm→btn-secondary`, `btn-xs→removed`) consistent everywhere. ✔
