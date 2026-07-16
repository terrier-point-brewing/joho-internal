# Bulk can variation creator

**Date:** 2026-07-16
**Branch:** `claude/bulk-can-variation-creator-2bf679`
**Status:** Approved (design), pending implementation plan

## Problem

`PackagingVariationsPanel.tsx` creates one `packaging_variations` row at a time via a modal, with
a free-text `name` field the user types by hand. In practice, releasing a new can SKU (e.g. "CBC
Pumpkin Reaper Ale") means creating 1–4 variations that share the same container/lid/label/partner
and differ only by format (Loose, 4-Pack, 6-Pack, Case) and that format's carrier item
(PakTech for 4-/6-Pack, Tray for Case) — today that's up to 4 separate modal round-trips, each
requiring the user to hand-type a name that must exactly follow the established convention (see
`supabase/migrations/20260707_beer_specific_packaging_variations.sql`) or the data silently drifts
from it.

This adds a "Bulk Create" flow: pick the shared base fields once, see the computed names for all
valid can formats, choose which ones to actually create (with their format-specific carrier item),
and submit them all in one action.

## Decisions (locked)

1. **Cans only.** Kegs have no format/lid/label fanout (they're always `format: "loose"` with no
   carrier item), so they don't fit this flow's premise. The existing single "+ Add Variation"
   modal remains the only path for kegs, and for any one-off can edits after the fact. The new
   entry-point button is labeled plainly **"Bulk Create"** (not "Bulk Create (Cans)") since the
   container picker inside it is restricted to `type: "can"` regardless — the label stays generic
   so it isn't a lie if keg support is added to the same flow later.
2. **Naming is generated, not typed**, following the convention already established in
   `20260707_beer_specific_packaging_variations.sql`:
   - `sizeLabel` = the chosen container's `name` with a trailing `"Blank"` token stripped
     (case-insensitive, whitespace-trimmed) — e.g. `"16oz Blank"` → `"16oz"`. If the container name
     has no trailing `"Blank"` token, `sizeLabel` falls back to the full container name unchanged.
   - `canTypeLabel` = `"Labeled Can"` if a label is chosen, else `"Printed Can"`.
   - `Loose`: `{baseName} - {sizeLabel} {canTypeLabel}`
   - `4-Pack` / `6-Pack` / `Case`: `{baseName} - {sizeLabel} {canTypeLabel} {formatSuffix}` where
     `formatSuffix` is `"4-Pack"` / `"6-Pack"` / `"Case"`.
   - The generated name is **editable per row** before submit (pre-filled, not locked) — same
     escape hatch the single-variation modal already gives via its free-text `name` field.
3. **Dedupe: auto-detect existing combos, pre-uncheck, don't hard-block.** Before showing the
   format rows, the modal fetches existing variations for the chosen container and flags any row
   whose `(container_id, format, lid_id, paktech_id, tray_id, label_id, partner_id)` tuple already
   matches one. Matched rows render an "Already exists" badge and start unchecked; the user can
   still check one to intentionally create a duplicate (no server-side block — this mirrors the
   single-variation route, which has never enforced uniqueness).
4. **One partner per batch**, matching the base-fields step — not a per-row choice. Same optionality
   as today (blank = generic, no partner).
5. **Single bulk POST, one Postgres statement.** All checked rows are inserted via one
   `.insert([...])` call (not looped one-row-at-a-time) — a multi-row insert is atomic in Postgres,
   so there's no partial-failure state to design around within a single submit.
6. **No DB schema changes.** No new table, no new column, no new unique constraint. `total_volume_fl_oz`
   is computed per row the same way the existing single-variation POST route computes it today.

## Naming logic — new `lib/production/bulkCanVariationNaming.ts`

Pure functions, no I/O:

```ts
export function buildCanSizeLabel(containerName: string): string;
// "16oz Blank" -> "16oz"; "16oz" -> "16oz" (no "Blank" suffix, returned as-is, trimmed)

export function buildCanVariationName(input: {
  baseName: string;
  containerName: string;
  format: PackagingVariationFormat; // "loose" | "4-pack" | "6-pack" | "case"
  isLabeled: boolean;
}): string;
```

`buildCanVariationName` calls `buildCanSizeLabel` internally and applies the pattern from Decision
2. Co-located `bulkCanVariationNaming.test.ts` covers: stripping `"Blank"` with/without extra
whitespace and case variants (`"Blank"`, `"blank"`, `"BLANK"`), no-`"Blank"`-suffix fallback, all
four formats, and both `isLabeled` states — 4 formats × 2 label states + a few sizeLabel edge cases.

## Dedupe logic — new pure helper, same file or `lib/production/packagingVariations.ts`

```ts
export interface VariationCombo {
  container_id: string;
  format: PackagingVariationFormat;
  lid_id: string | null;
  paktech_id: string | null;
  tray_id: string | null;
  label_id: string | null;
  partner_id: string | null;
}

export function isDuplicateCombo(candidate: VariationCombo, existing: VariationCombo[]): boolean;
```

Straight tuple equality (all six nullable FK fields + format, `null === null` matches). Kept as a
pure function so it's unit-testable without a live Supabase call — the API route and the client
preview both call it against the same existing-variations list (client fetches it once when the
container is chosen, for the "Already exists" badges; server re-checks it before insert as the
authoritative gate against races between the two — a row skipped server-side is reported in
`skipped`, not silently dropped).

## API — new `app/api/production/packaging-variations/bulk/route.ts`

`POST` only, `requireRole(["brewer"])` (matches existing single route).

Request body:
```ts
{
  items: Array<{
    container_id: string;
    format: PackagingVariationFormat;
    lid_id: string;                 // required for every can row
    paktech_id: string | null;
    tray_id: string | null;
    label_id: string | null;
    partner_id: string | null;
    name: string;
  }>;
}
```

Handler:
1. `items.length >= 1`, else 400.
2. Per item: `validateFormat(format, paktech_id, tray_id)` (reused from
   `lib/production/packagingVariations.ts`, unchanged) and require `container_id`, `lid_id`, `name`
   truthy — same required-field shape the single route already enforces for cans. Any failing item
   is dropped from the insert set and recorded in `skipped` with its `name` and the validation
   message as `reason`; this does not abort the rest of the batch (client-side gating in Step 2
   should make this path unreachable in normal use — it's defense in depth, not the primary UX).
3. Fetch every `container_id` referenced in `items` once, confirm each resolves to a
   `packaging_items` row with `type: "can"` (reject the whole request 400 if not — a non-can
   container id reaching this route means the client is misbehaving, not a per-row skip case).
4. Fetch existing `packaging_variations` rows for the referenced container_id(s) (one query,
   `container_id.in.(...)`), map to `VariationCombo[]`, and run `isDuplicateCombo` per item;
   duplicates go to `skipped` with `reason: "already exists"` rather than into the insert set.
5. For each remaining item, compute `total_volume_fl_oz` via the existing
   `computeTotalVolumeFlOz` (unchanged, one call per item — same N-query shape the single route
   already has per-request, just now N items instead of N requests).
6. Single `supabase.from("packaging_variations").insert([...rows]).select(PACKAGING_VARIATION_SELECT)`.
7. Response: `{ created: PackagingVariation[], skipped: Array<{ name: string; reason: string }> }`,
   status 201 if `created.length > 0`, else 200 with an empty `created` (not an error — "everything
   was already a duplicate" is a valid, non-exceptional outcome).

## UI — new `app/production/components/BulkCanVariationModal.tsx`

Triggered by a new **"Bulk Create"** button in `PackagingVariationsPanel.tsx`, placed next to the
existing `+ Add Variation` button (same header row, `app/production/components/PackagingVariationsPanel.tsx:214-219`).
Uses `Modal` (`extraWide`, per the `BulkReceiveModal.tsx` precedent) / `Field` / `ModalActions` from
`./shared`. Internal two-step state (`step: "base" | "formats"`), not two separate modals.

**Step "base"** — same field set/order as the existing single-variation modal's can branch, minus
`Format`/`PakTech`/`Tray` (those move to Step "formats" as per-row fields) and minus free-text
`Name` (generated):
- Base Name (text, required) — seeds `baseName` used by the naming function.
- Container (select, `packaging.filter(p => p.type === "can")`, required) — reuses the same
  `usePackagingQuery()` data source the panel already loads.
- Lid (select, `type: "lid"`, required) — applies to every generated row.
- Can Type: Printed Can / Labeled Can (radio, same UX as the existing `is_labeled` toggle).
- Label (select, `type: "label"`, required only if Labeled Can) — applies to every generated row.
- Partner (select, `contract_brewing_partners`, optional, blank = generic) — applies to every row.
- "Next" advances to Step "formats" once the required fields above are filled; on advancing, fetch
  existing variations for the chosen `container_id` (`GET /api/production/packaging-variations`
  already returns all variations with joins — filter client-side by `container_id`, no new GET
  endpoint needed) to compute the "Already exists" flags.

**Step "formats"** — one row per `FORMATS` entry (reuse the existing `FORMATS` const from
`PackagingVariationsPanel.tsx:15-20`, imported or hoisted to a shared location since both files
need it):
- Checkbox (include this row in the submit).
- Generated name, pre-filled via `buildCanVariationName`, editable text input.
- Format-specific extra field, shown only when relevant (reusing `needsPaktech`/`needsTray` from
  `PackagingVariationsPanel.tsx:24-25`, same hoist-or-import as `FORMATS`):
  - `loose`: no extra field.
  - `4-pack` / `6-pack`: PakTech select (`packaging.filter(p => p.type === "paktech")`), required
    to check the row.
  - `case`: Tray select (`packaging.filter(p => p.type === "tray")`), required to check the row.
- "Already exists" badge + unchecked-by-default when `isDuplicateCombo` matches (Decision 3);
  checkbox stays interactive so the user can override.
- Checking a row whose required extra field is empty shows an inline validation message and
  excludes it from the ready-to-submit count (mirrors the required-field pattern the single modal
  already uses for PakTech/Tray).
- "Back" returns to Step "base" without losing entered values.
- "Create N Variations" (N = checked-and-ready count), disabled at N = 0. On click, POSTs the
  checked rows to the bulk route; success closes the modal, invalidates
  `productionKeys.packagingVariations` (same `onRefresh` the single modal calls), and the panel's
  table refreshes. On failure, an inline `Banner`-style error stays in the modal (state preserved,
  nothing lost) rather than closing.

## Error handling

- Client-side gating (Step "base" required fields; Step "formats" required PakTech/Tray per
  checked row) prevents most invalid submissions before they reach the network.
- Server-side re-validates everything (never trust the client) per the API section above; a
  malformed or duplicate row is skipped and reported, not a hard 500/400 for the whole batch,
  **except** a `container_id` that doesn't resolve to a `type: "can"` `packaging_items` row, which
  rejects the entire request (that's a client bug, not a per-row data issue).
- Network/API failure (non-2xx or thrown fetch) shown as an inline error in the modal; form state
  (all checkboxes, edited names, base fields) is preserved so the user can retry without redoing
  their selections.

## Testing

- `lib/production/bulkCanVariationNaming.test.ts` — naming + size-label edge cases (see Naming
  logic section above).
- `isDuplicateCombo` unit tests — exact match, mismatched single field (each of the 7 fields in
  turn), empty `existing` array.
- Route tests for `POST /api/production/packaging-variations/bulk`: happy path (multiple rows
  created in one call), per-row skip on validation failure, per-row skip on duplicate, whole-request
  reject on non-can `container_id`, role gate (non-brewer rejected).
- `npm run verify` green (lint + typecheck + tests); keep `lib/` coverage above the vitest floor.
- Manual browser verification (per CLAUDE.md UI convention): run the dev server, open Recipes →
  Packaging Variations, walk through Bulk Create end-to-end for a labeled-can example matching the
  brief's own worked example (`CBC Pumpkin Reaper Ale`), confirm all four generated names match the
  spec exactly, confirm the "Already exists" badge appears on a second run against the same
  container/lid/label/partner combo.

## Out of scope / non-goals

- Kegs, or any non-can container type, in this flow.
- Any change to the existing single-variation create/edit modal, its API route, or its free-text
  `name` field (it stays free text — this spec only formalizes naming for the new bulk path).
- A DB-level unique constraint preventing duplicate combos (dedupe stays app-level only, per
  Decision 3) — this is unchanged pre-existing behavior for the single-variation route too.
- Bulk edit or bulk delete of existing variations (only bulk *create* is in scope).
- Editing/undoing a bulk-created batch after submission as a single unit — individual rows can
  still be edited/deleted one at a time via the panel's existing per-row Edit/Delete, unchanged.
