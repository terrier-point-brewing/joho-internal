# Brand Guide Phase 2 — Illustrated Rules Implementation Plan

> Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Introduce the `GuideRule` primitive and use it to turn Visual Identity and the Color tab's forbidden list into two-column do/don't grids with room for imagery.

**Execution Budget:** inline execution (no subagents this session) · token target ≈ 120k.

**Architecture:** One new canon primitive reused by two subtabs, one shared `RuleCard`/`RuleGrid`/`AssetImage` trio in the block kit, and one typed editor. Rule arrays widen to a union of `string | GuideRule` so existing documents keep parsing; a pure normalizer upgrades legacy strings on read, and a migration rewrites stored rows to the rich shape.

## Global Constraints

Same as phase 1: brand tokens only under `app/brand/guide/**`, app tokens for editor chrome, no hand-rolled primitives, React Compiler rules enforced as lint errors, `npm run verify` is the definition of done, migrations are human-gated.

⚠️ **No browser verification available** (login wall).

---

## Deviation from the proposal — read this

Proposal §3.3 specifies renaming `illustrationLaw.rules` → `visual.rules`. **This plan keeps the existing storage keys** (`illustrationLaw.rules`, `colorForbidden`) and only widens their element type.

Reason: a key rename requires the migration to land in lockstep with the deploy, because `getCanon()` does not validate on read — a published document whose keys moved would render an empty subtab rather than fail loudly. Widening the type cannot break anything: old string rules keep working with or without the migration. Phase 0 established this ordering discipline for the asset URLs and it applies here for the same reason.

The rename buys nothing the user can see. It is left as optional cleanup once the migration has been applied everywhere.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/brand/canon.schema.ts` *(modify)* | `guideRuleSchema`; widen the two rule arrays to `string \| GuideRule`. |
| `lib/brand/guideRules.ts` *(new)* | `normalizeRules`, `splitByPolarity` — pure, tested. |
| `app/brand/guide/blocks/AssetImage.tsx` *(new)* | Aspect-locked, `object-contain` image box. The one place "uploads can't break the grid" lives. |
| `app/brand/guide/blocks/RuleCard.tsx` *(new)* | Polarity chip + title + detail + optional image. |
| `app/brand/guide/blocks/RuleGrid.tsx` *(new)* | Do column / Don't column. |
| `app/brand/guide/VisualIdentityView.tsx` *(modify)* | Compose `RuleGrid`. |
| `app/brand/guide/ColorView.tsx` *(modify)* | Forbidden section → `RuleGrid`, don't-only. |
| `app/brand/canon/fields/RuleListField.tsx` *(new)* | Typed rule editor with an asset picker. |
| `app/brand/canon/CanonEditor.tsx` *(modify)* | visual + colorForbidden off `SliceJsonFacet`. |
| `supabase/migrations/20260904_brand_canon_guide_rules.sql` *(new)* | Rewrite stored string rules to the rich shape. |

---

### Task 1: `GuideRule` schema + normalizer

**Interfaces:**
```ts
// canon.schema.ts
const guideRuleSchema = z.object({
  id: idSchema,
  polarity: z.enum(["do", "dont"]),
  title: z.string(),
  detail: z.string().optional(),
  assetId: z.string().optional(),
  caption: z.string().optional(),
});
// illustrationLaw.rules and colorForbidden become:
//   z.array(z.union([z.string(), guideRuleSchema]))

// lib/brand/guideRules.ts
export type GuideRule = z.infer<typeof guideRuleSchema>;
export function normalizeRules(
  input: (string | GuideRule)[] | undefined,
  fallbackPolarity: "do" | "dont",
): Required<Pick<GuideRule, "id" | "polarity" | "title">> & GuideRule[];   // see note
export function splitByPolarity(rules: GuideRule[]): { dos: GuideRule[]; donts: GuideRule[] };
```
`normalizeRules` returns `GuideRule[]` with every item carrying an id — a legacy string becomes `{ id: <derived>, polarity: fallbackPolarity, title: <the string> }`.

**Legacy id derivation:** a legacy string has no id, and `crypto.randomUUID()` here would produce a different id on every render, breaking React keys and `diffCanon`. Derive a stable id from the string instead (`legacy:${index}`), and let the migration replace it with a real uuid.

- [ ] **Step 1: Write `guideRules.test.ts`** — legacy strings become `dont` rules for `colorForbidden` and `do` for visual; ids are stable across two calls; existing GuideRule objects pass through untouched; `splitByPolarity` partitions correctly; `undefined` input yields `[]`.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement schema + normalizer**
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: `npm run verify`; commit**

**Acceptance:** the existing published canon still parses. Normalizing twice is stable.

---

### Task 2: Block kit additions

`AssetImage` renders a fixed `aspect-[16/10]` box with `object-contain` on `bg-brand-surface`, so a 4000px PNG and a 200px SVG land identically. With no `assetId` it renders a neutral placeholder — phase 2 ships the structure before the artwork exists, per Q8.

`RuleCard` = polarity chip + title + optional detail + `AssetImage`. `RuleGrid` = two columns with `Do` / `Don't` headers, stacking below `sm`.

- [ ] **Step 1: Implement the three blocks**
- [ ] **Step 2: `npm run verify`; confirm no raw colors; commit**

---

### Task 3: Views

Visual Identity: `RuleGrid` over `normalizeRules(canon.illustrationLaw?.rules, "do")`. Color: the forbidden section becomes a don't-only `RuleGrid` over `normalizeRules(canon.colorForbidden, "dont")`.

- [ ] **Step 1: Rewrite both views**
- [ ] **Step 2: `npm run verify`; commit**

---

### Task 4: Rule editor + migration

`RuleListField` wraps `ListField` (phase 1): polarity select, title, detail, and an asset picker listing `kind=example` assets with inline upload.

Migration `20260904` rewrites `illustrationLaw.rules` and `colorForbidden` in the published and draft rows from `["string", …]` to `[{id, polarity, title}, …]`, assigning `gen_random_uuid()` per rule. Idempotent: skip elements that are already objects.

- [ ] **Step 1: Implement `RuleListField`**
- [ ] **Step 2: Rewire `CanonEditor` for `visual` and `colorForbidden`; drop `visualSlice`/`colorForbiddenSlice`**
- [ ] **Step 3: Write the migration. Do NOT apply.**
- [ ] **Step 4: `npm run verify`; commit; report the pending migration**

**Acceptance:** rules edit through typed inputs; images attach; the guide renders identically whether or not the migration has run.
