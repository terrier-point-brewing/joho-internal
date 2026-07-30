# Brand Guide Phase 1 — Ethos + Voice Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the shared block kit and the first typed field editors, and use them to fix the Ethos and Voice subtabs' readability problems.

**Execution Budget:** inline execution (no subagents available this session) · token target ≈ 120k.

**Architecture:** Two mirrored kits. `app/brand/guide/blocks/` holds presentational components the guide views compose, using brand tokens only. `app/brand/canon/fields/` holds typed editors that replace the raw-JSON `SliceJsonFacet` for these two subtabs. Ethos and Voice are then rewritten as compositions of those blocks — no bespoke markup that a later subtab can't reuse.

**Tech Stack:** Next.js 16 · React 19 · TypeScript · Tailwind v4 · Vitest

## Global Constraints

- **Brand tokens only in `app/brand/guide/**`** — `text-brand-*`, `bg-brand-*`, `border-brand-*`, `font-brand-*`. Never `zinc-*`/`amber-*`/hex literals. Editor chrome under `app/brand/canon/**` uses app tokens (`bg-surface`, `text-muted`, `.btn-*`, `.inp`).
- **No hand-rolled primitives.** Buttons → `.btn-primary`/`.btn-secondary`/`.btn-danger` (+ `.btn-xxs`). Inputs → `.inp`/`.inp-sm`. Never a bordered `<button>` built by hand.
- **Type scale only** — no arbitrary `text-[Npx]`.
- **React Compiler rules are enforced as lint errors.** No ref reads/writes during render; no `setState` synchronously inside an effect. Both were hit in phase 0.
- **Canon shape changes ship with a migration** and are human-gated. Phase 1 aims to need none — reuse the existing `values` and `voice` shapes.
- **`npm run verify`** (lint + typecheck + tests) is the per-task definition of done.
- ⚠️ **No browser verification is available** (login wall; credentials must not be entered). Structure is verified by tests and typecheck; visual review is the founder's.

---

## File Structure

**Block kit — `app/brand/guide/blocks/`**
| File | Responsibility |
|---|---|
| `SubHead.tsx` | Section kicker + optional description, with real hierarchy between them. |
| `SpecCard.tsx` | Titled card whose body is labelled field rows. |
| `ComparisonCard.tsx` | Labelled left vs right, side by side; stacks on mobile. |
| `SliderRow.tsx` | Labelled 0–100 track with numeric readout and a prominent note. |
| `ChipList.tsx` | A labelled row of word chips. |

**Field kit — `app/brand/canon/fields/`**
| File | Responsibility |
|---|---|
| `ListField.tsx` | Generic add/remove/reorder wrapper for a list of items. |
| `CardListField.tsx` | Ethos values — title / means / cost. |
| `SliderListField.tsx` | Voice calibration — poles, position, note. |
| `PairListField.tsx` | Voice rewrites — context / on / off. |
| `WordListField.tsx` | Voice vocabulary — comma-separated word lists. |

**Rewritten**
| File | Change |
|---|---|
| `app/brand/guide/EthosView.tsx` | Compose `SpecCard`. |
| `app/brand/guide/VoiceView.tsx` | Compose `SubHead` + `SliderRow` + `ChipList` + `ComparisonCard`. |
| `app/brand/canon/CanonEditor.tsx` | Ethos and Voice swap `SliceJsonFacet` → typed fields. |

---

## Task Table

| # | Task | Model |
|---|---|---|
| 1 | Block kit | Sonnet |
| 2 | Ethos view | Sonnet |
| 3 | Voice view | Sonnet |
| 4 | Field kit + editor rewiring | Sonnet |

---

### Task 1: Block kit

**Files:** Create the five files under `app/brand/guide/blocks/`, plus `app/brand/guide/blocks/blocks.test.tsx`.

**Interfaces:**
```tsx
export function SubHead({ title, description }: { title: string; description?: string }): ReactElement;

export function SpecCard({ eyebrow, title, rows }: {
  eyebrow?: string;
  title: string;
  rows: { label: string; value: string; tone?: "default" | "accent" }[];
}): ReactElement;

export function ComparisonCard({ context, left, right }: {
  context: string;
  left: { label: string; value: string };
  right: { label: string; value: string };
}): ReactElement;

export function SliderRow({ left, right, pos, note }: {
  left: string; right: string; pos: number; note: string;
}): ReactElement;

export function ChipList({ label, words, tone }: {
  label: string; words: string[]; tone?: "neutral" | "accent";
}): ReactElement;
```

**Design notes:**

`SliderRow` inverts today's hierarchy. Currently the pole labels and the note share one class (`text-xs text-brand-content-muted`), so nothing stands out. The note becomes the primary readable line (`text-sm text-brand-content`) and the poles drop to small muted text at the track ends. A right-aligned `tabular-nums` readout shows `pos`, and tick marks sit at 0/25/50/75/100. Clamp `pos` into 0–100 before using it for positioning — a canon value outside that range must not push the dot outside the track.

`SpecCard` gives every row the same label treatment. Today Ethos labels only `cost`, leaving `means` as unlabelled body text; that asymmetry is the readability complaint. `tone: "accent"` colours the label only, never the value.

`ComparisonCard` is `grid sm:grid-cols-2` with a divider between columns, stacking to one column below `sm`.

- [ ] **Step 1: Write `blocks.test.tsx`** — render each block with `@testing-library/react` if present, otherwise assert the pure helpers only (see Step 2). Cases: `SliderRow` clamps `pos` above 100 and below 0; `SpecCard` renders one row per entry; `ChipList` renders nothing when `words` is empty; `ComparisonCard` renders both labels.

- [ ] **Step 2: Check whether a DOM testing library is available**

Run: `node -e "require.resolve('@testing-library/react')"` — if it resolves, write render tests. If it does NOT, extract the clamping/format logic into exported pure helpers (`clampPos`, `hasContent`) and test those instead; do NOT add a new dependency for this.

- [ ] **Step 3: Run the test — expect FAIL**

- [ ] **Step 4: Implement the five blocks**

- [ ] **Step 5: Run the test — expect PASS**

- [ ] **Step 6: `npm run verify`, then commit**

**Acceptance:** No raw color utilities in any block. `pos` outside 0–100 cannot escape the track.

---

### Task 2: Ethos view

**Files:** Modify `app/brand/guide/EthosView.tsx`.

**Design notes:**

One `SpecCard` per value: eyebrow `{v.n}`, title `{v.title}`, rows `[{label: "What it means", value: v.means}, {label: "The cost", value: v.cost, tone: "accent"}]`. Keep the existing `grid gap-3 sm:grid-cols-2` and the `canon.values?.length > 0` guard.

- [ ] **Step 1: Rewrite the view as a `SpecCard` composition**
- [ ] **Step 2: `npm run verify`, then commit**

**Acceptance:** `means` and `cost` carry visually equal labels.

---

### Task 3: Voice view

**Files:** Modify `app/brand/guide/VoiceView.tsx`.

**Design notes:**

Three sub-sections in this order — the ordering is the point, per the founder's call:

1. **Calibration** — `SubHead` + a `SliderRow` grid.
2. **Vocabulary** — `SubHead` + two `ChipList`s (`Lean on` neutral, `Never` accent). Promoted out of the buried inline line it lives on today.
3. **In practice** — `SubHead` + `ComparisonCard` per rewrite, `✓ On-voice` left and `✕ Off-voice` right, so the difference reads horizontally.

- [ ] **Step 1: Rewrite the view**
- [ ] **Step 2: `npm run verify`, then commit**

**Acceptance:** Vocabulary sits between Calibration and In practice. Rewrites read left-to-right.

---

### Task 4: Field kit + editor rewiring

**Files:** Create the five files under `app/brand/canon/fields/`; modify `app/brand/canon/CanonEditor.tsx`.

**Interfaces:**
```tsx
export function ListField<T>({ label, description, items, onChange, blank, renderItem }: {
  label: string;
  description?: string;
  items: T[];
  onChange: (next: T[]) => void;
  blank: () => T;                      // a new empty item, WITH a fresh id
  renderItem: (item: T, update: (patch: Partial<T>) => void) => ReactNode;
}): ReactElement;
```
Each concrete field wraps `ListField` and supplies `blank` + `renderItem`.

**Design notes:**

This is the change that kills the silent-edit failure at its source: with typed inputs there is no JSON blob to mis-type, so an edit cannot fail to reach the draft.

`blank()` must assign `crypto.randomUUID()` to `id`. An item without one breaks `diffCanon`'s identity matching and would be reported as a delete-plus-add on the next publish.

`ListField` owns add / remove / move-up / move-down. Reorder must preserve ids (move the whole item object) — a reorder that rebuilt items would defeat the id matching phase 0 established.

In `CanonEditor`, replace for `section === "ethos"` and `section === "voice"` only:
- ethos → `<CardListField draft={draft} onChange={setDraft} />`
- voice → `<SliderListField/>` + `<WordListField/>` ×2 + `<PairListField/>`

Leave `visual`, `agent` and `colorForbidden` on `SliceJsonFacet` — those are phases 2 and 3. Delete `ethosSlice` and `voiceSlice` from `canonSlices.ts` once unused.

- [ ] **Step 1: Implement `ListField` and the four concrete fields**
- [ ] **Step 2: Rewire `CanonEditor` for ethos and voice; drop the now-unused slices**
- [ ] **Step 3: `npm run verify`**
- [ ] **Step 4: Confirm no JSON textarea remains for these two subtabs** — `grep -n "SliceJsonFacet" app/brand/canon/CanonEditor.tsx` must show no `ethos`/`voice` usage
- [ ] **Step 5: Commit**

**Acceptance:** Ethos and Voice edit through typed inputs. New items carry ids. Reordering preserves ids.

---

## Self-Review

**Spec coverage** (proposal §3.1–3.2):

| Requirement | Task |
|---|---|
| Label `means` like `cost` (§3.1) | 2 |
| Numeric readout on sliders (§3.2) | 1, 3 |
| Note outranks pole labels (§3.2) | 1, 3 |
| Vocabulary between calibration and in-practice (§3.2, Q7) | 3 |
| Left/right rewrites (§3.2) | 1, 3 |
| Typed editors replacing JSON (§1.1, §4.3) | 4 |

**Out of scope:** Visual Identity, Color, Type, Marks, Agent Rules; the `GuideRule` primitive (phase 2); palette work (phase 3).

**Type consistency:** `SpecCard`'s `rows` and `ComparisonCard`'s `left`/`right` are defined in Task 1 and consumed unchanged in Tasks 2–3. `ListField`'s generic signature is defined in Task 4 and used by all four concrete fields in the same task.

**Known risk:** no browser verification. The blocks are presentational, so a layout mistake will not fail any test. Mitigate by rendering the composed output for founder review before merge.
