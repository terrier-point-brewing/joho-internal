# Mobile UI Review — 2026-10-13

Scope: the ops app at phone width (390 × 844, Chrome). Pages sampled: Production
Intake / Brewing / Export, Finance Financials / Transactions, Settings Account.
Code sampled: `app/globals.css`, `app/layout.tsx`, `NavBar`, `StickyHeader`,
`PageHeader`, `SubNav`/`TabBar`/`tabStyles`, `ButtonGroup`, `ToggleChip`,
`FilterBar`/`FilterChips`/`SearchInput`, `Modal`, `Card`, `SortableTh`, plus
repo-wide greps.

Standards applied: WCAG 2.2 AA (2.5.8 target size ≥ 24 px, 1.4.4 resize text,
2.4.7 focus visible, 1.3.1 info & relationships), Apple HIG / Material (44–48 px
primary targets), and the house rule that every fix lands in `globals.css` or a
shared layout component — never per-page.

---

## Verdict

The shell is already centralised (one `StickyHeader`, one tab style, one button
primitive, one modal), so most mobile problems can be fixed in **six shared
places** and inherited by all 110 pages. Nothing here needs a per-page edit.

Measured at 390 × 844:

| Chrome element | Height | Notes |
|---|---|---|
| Top bar (fixed) | 44 px | email + role, no actions |
| Frozen header (`StickyHeader`) | 192 px | area tabs + title + description + subtabs |
| Bottom nav (fixed) | 51 px | 7 items @ 56 px wide, 10 px labels |
| **Total fixed chrome** | **287 px = 34 % of the screen** | content gets ~557 px |

| Control | Height | WCAG 2.5.8 min | HIG target |
|---|---|---|---|
| `.btn-*` default | 26 px | 24 ✔ | 44 ✘ |
| `.btn-xxs` (153 uses) | ~18 px | 24 ✘ | ✘ |
| `ToggleChip` / `FilterChips` | 26 px | ✔ | ✘ |
| `.inp-sm` | 28 px | ✔ | ✘ |
| Tab item | 42 px | ✔ | ~✔ |
| Table `<th>` sort target | 33 px | ✔ | ✘ |

Type: 250 text nodes on Intake and 374 on Brewing render **below 12 px**; the
Brewing floorplan goes down to 7–9 px (exempt canvas, but it is the page brewers
open on a phone).

---

## Findings (ranked)

### P1 — Fixed chrome eats a third of the phone screen
`StickyHeader` pins area nav + title + description + subtabs. On a phone that is
192 px plus 95 px of top bar and bottom nav. The description paragraph
("Commitments and fulfillment — track what has been allocated…") is the biggest
single cost and carries no navigation value while scrolling.

### P1 — Horizontal scrolling with no affordance
The area `SubNav` and section `TabBar` rows overflow (`Recipes | In…`,
`Transfe…`, `Bank Ledg…`) with `scrollbar-none` and no fade, so the user cannot
tell more tabs exist. The same applies to 37 table wrappers (`overflow-x-auto`)
and the 18 table files with no wrapper at all (those overflow the page).

### P1 — Touch targets below platform minimum
All three button tiers are 26 px tall; `.btn-xxs` is ~18 px, which fails WCAG
2.5.8 outright. Table-row action strips (`btn-xxs` × 153 uses) and the `×`
modal close (a bare text glyph, no padding) are the worst cases.

### P2 — Double scroll regions on finance tables
Finance Transactions renders the orders table inside a `max-h-[60vh]` card that
is itself inside the page's scroll pane. On a phone the table window is ~140 px
tall and scrolling it fights the page scroll.

### P2 — Filter bars stack into a wall
`FilterBar` is `flex-wrap`; at 390 px a page like Transactions becomes seven
rows of chips, selects and buttons (search, two dates, mapping select, GL
select, Auto-map, sync row) before any content. `SearchInput` is pinned to
`w-64` so it never fills the row and leaves an awkward gap.

### P2 — Bottom nav: 7 items at 56 px, 10 px labels, Sign out as a tab
Six sections plus Sign out share 390 px. HIG caps tab bars at 5; "Sign out" is
not a destination and belongs in the account surface (top bar / Settings).
Labels are `text-[10px]`, below the sanctioned `text-2xs`'s own floor for body
copy.

### P2 — Dense type on the pages used standing up
`text-2xs` (10 px) is used 321 times. The standard restricts it to table meta,
but it is the de-facto size on floorplan tiles, keg strips and badge text. At arm's
length on a phone 10 px is not legible.

### P3 — Keyboard / screen-reader gaps
- `focus-visible` styling exists only for `.btn-*` and `.inp*`; tabs, chips,
  `SortableTh` (a clickable `<th>` with no `button`/`aria-sort`) and nav links
  have no visible focus ring.
- 17 icon-only buttons on Brewing have no accessible name; 9 bare `×` closes
  repo-wide.
- 21 files still call `window.confirm` (not themeable, not testable, blocks the
  thread on iOS).
- 112 `type="number"` inputs vs 21 `inputMode` — iOS shows the full keyboard
  for most numeric fields.
- Only one `aria-live` region app-wide; save/toast feedback is visual only.
- `Modal` has no focus trap and does not return focus on close.
- 19 raw `<h1>/<h2>` outside `PageHeader` break the heading outline.

### P3 — Unprefixed multi-column grids
15 `grid-cols-3+` with no breakpoint prefix; these squeeze KPI tiles and form
rows to ~110 px columns on a phone.

---

## Proposed changes — all global, no per-page work

Each item names the single file it lives in. Order = ship order.

### 1. `globals.css` — a `--control-h` ladder and 44 px hit areas
```css
:root {
  --control-h-sm: 1.75rem;   /* 28px  .inp-sm / .btn-xxs */
  --control-h:    2.25rem;   /* 36px  .btn-* / .inp / ToggleChip */
  --tap-min:      2.75rem;   /* 44px  touch extension, mobile only */
}
.btn-primary, .btn-secondary, .btn-danger, .inp, .inp-sm, [aria-pressed] {
  min-height: var(--control-h);
}
.btn-xxs { min-height: var(--control-h-sm); font-size: 0.6875rem; } /* 11px, not 10 */
@media (pointer: coarse) {
  /* Extend the hit area without changing the visual box. */
  .btn-primary, .btn-secondary, .btn-danger, .btn-xxs, [aria-pressed] {
    position: relative;
  }
  .btn-primary::after, .btn-secondary::after, .btn-danger::after,
  .btn-xxs::after, [aria-pressed]::after {
    content: ""; position: absolute; inset: 50% auto auto 50%;
    width: max(100%, var(--tap-min)); height: max(100%, var(--tap-min));
    transform: translate(-50%, -50%);
  }
}
```
Effect: every button, chip and input in the app clears HIG on touch devices,
desktop visuals unchanged. `pointer: coarse` keeps the desktop dense.

### 2. `globals.css` — one focus ring for everything interactive
```css
:where(a, button, [role="button"], [tabindex]):focus-visible {
  outline: 2px solid var(--color-accent); outline-offset: 2px; border-radius: 0.25rem;
}
```
Covers tabs, chips, nav links and `SortableTh` in one rule. Remove the three
duplicate `.btn-*:focus-visible` / `.inp:focus-visible` blocks.

### 3. `globals.css` + `tabStyles.ts` — scroll affordance for overflow rows
Add a `.scroll-x` utility used by `TAB_ROW`, the mobile `SubNav` and `Card`'s
table variant:
```css
.scroll-x {
  overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
  -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
  mask-image: linear-gradient(to right, #000 calc(100% - 2rem), transparent);
}
.scroll-x > * { scroll-snap-align: start; }
```
The right-edge fade tells the user there is more; snap keeps a tab fully in
view after a swipe. `TAB_ROW` drops its own `overflow-x-auto … scrollbar-none`
and takes `scroll-x`.

### 4. `StickyHeader.tsx` + `PageHeader.tsx` — collapse the frozen header on phones
- `PageHeader` renders `description` as `hidden sm:block` (it stays in the DOM
  for screen readers via `sr-only` on mobile).
- `StickyHeader` gets `pt-2 sm:pt-8` and the mobile area `SubNav` moves **out**
  of the sticky block into a non-sticky strip above it. The sticky block then
  holds only title + section subtabs: ~80 px instead of 192 px.
- Result: fixed chrome drops from 287 px to ~175 px (21 % of the screen).

### 5. `Card.tsx` — a `scroll="x"` prop so tables never overflow the page
```tsx
<Card padding="" scroll="x">  // → className += " scroll-x -mx-4 sm:mx-0 rounded-none sm:rounded-lg"
```
One prop replaces the 37 hand-written `overflow-x-auto` wrappers and fixes the
18 tables that have none. The `-mx-4` bleed is the standard's own mobile bleed
rule (§3). Finance's inner `max-h-[60vh]` scroll cards switch to `scroll="x"`
only, letting the page pane own vertical scroll (removes the double scroll).

### 6. `FilterBar.tsx` + `SearchInput.tsx` — phone layout for controls
- `FilterBar`: `grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:gap-3`. On a
  phone every control is full-width and stacks in one column; desktop unchanged.
- `SearchInput`: `w-full sm:w-64`.
- Add a `collapsible` prop: on `< sm` the bar renders behind a single
  `Filters (n)` `.btn-secondary` toggle so the table is visible on first paint.
  Pages opt in with one prop.

### 7. `NavBar.tsx` — bottom nav to five items, Sign out moves up
- Bottom nav shows at most 5 destinations; Brand and Marketing fold into a
  "More" sheet (a `Modal` listing the remaining sections) when the role can see
  more than five.
- Sign out moves to the top bar (tap the email → `ConfirmDialog` with Sign out).
- Labels go from `text-[10px]` to `text-2xs` and the bar height var
  `--mobile-nav-h` rises to 3.5rem so the 44 px target holds.

### 8. `Modal.tsx` — focus trap, return focus, phone sheet
- Trap Tab inside the dialog, focus the first field on open, restore the
  opener on close (one `useEffect`, ~20 lines).
- Replace the bare `×` with a `.btn-secondary` icon button carrying
  `aria-label="Close"` (it already has the label; it needs the hit area).
- On `< sm`: `items-end` + `max-h-[100dvh] rounded-b-none` so the modal is a
  bottom sheet rather than a 90 vh card floating above the keyboard.

### 9. `SortableTh.tsx` — real button semantics
Wrap the label in `<button type="button">` and emit `aria-sort`. The `<th>`
keeps `px-4 py-3`; the button takes `min-h-[var(--control-h)]`.

### 10. Lint rules (no runtime change)
Extend `eslint.config.mjs`'s existing `no-restricted-syntax` block:
- `type="number"` without `inputMode` → error.
- `window.confirm` / `alert(` → error (use `ConfirmDialog`).
- `grid-cols-[3-9]` without a `sm:` prefix → warning.
- Raw `<h1>`/`<h2>` outside `PageHeader` → error (already in the standard, not
  enforced).

---

## Out of scope (named, not fixed)
- Brewing floorplan canvas and keg tiles (7–10 px type). Exempt surface; a
  phone-specific tile layout is a design task, not a global rule.
- Per-page filter-bar content (which filters a page shows). The bar's *layout*
  is fixed globally in item 6; what goes in it is each page's call.

## Suggested delivery
Three PRs so each one is reviewable on its own and cannot regress desktop:
1. CSS only — items 1, 2, 3 (`globals.css`, `tabStyles.ts`).
2. Layout components — items 4, 5, 6, 9.
3. Nav + Modal — items 7, 8, then item 10's lint rules last.
