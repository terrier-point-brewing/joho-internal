# Shipment Editing Phase 1 — Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator edit a booked shipment's channel, recipient, and notes
from Production → Shipments, with guards, credit release, and an audit trail.

**Execution Budget:** Inline execution (`superpowers:executing-plans`) — one
locality group (production/shipments), ~9 files. **Spawn cap = 0.** No
subagents. The writing-plans skill's "subagent-driven (recommended)" stamp is
overridden by the CLAUDE.md tier table. Token target: ~120k.

**Architecture:** All guard logic is pure and lives in `lib/production/shipmentEdit.ts`,
exported for both server enforcement and client affordances so the UI can never
offer an edit the API rejects. A single shipment-scoped `PATCH` route is the
sole writer; it applies one `UPDATE ... WHERE shipment_id = $1` (atomic on its
own) and then re-checks any released allocations' commitments (idempotent).
Audit history comes from the existing `audit_log` + `audit_trigger_fn()`
infrastructure, whose trigger is currently missing on `export_transactions`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, Supabase
Postgres, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-30-shipment-editing-design.md`

## Global Constraints

- **Plans specify interfaces, not bodies.** Per CLAUDE.md token discipline, this
  plan gives signatures, types, acceptance criteria, and test cases. Inline code
  only where the logic is genuinely non-obvious, capped at ~20 lines per task.
  This overrides the writing-plans skill's "complete code in every step".
- **No raw colour utilities.** No `zinc-*`/`amber-*`/`red-*`/`green-*`/`blue-*`/
  `gray-*` or hex/rgb literals in feature code. Use token utilities only.
- **No hand-rolled primitives.** Buttons → `.btn-primary`/`.btn-secondary`;
  inputs → `.inp`/`.inp-sm`; modals → `Modal`/`Field`/`ModalActions` from
  `app/components/ui/Modal.tsx`; errors → `Banner` (default export).
- **Supabase client by context.** Route handlers use `createSupabaseServerClient`
  — never the browser or admin client. The session client is required so
  `auth.uid()` resolves inside `audit_trigger_fn`.
- **Every Supabase call checks `error`**, selects included — the client resolves
  with `{ error }` rather than throwing.
- **Migration filename:** take a full `YYYYMMDDHHMMSS` stamp and verify no
  collision against `supabase/migrations/` before writing. Plain-date prefixes
  have collided with parallel branches.
- **Migrations are never applied by this plan.** Author the file, link it, stop.
  The user applies it by hand.
- **DoD per task:** `npm run verify` (lint + typecheck + tests) passes.
- Legal channel transitions: `distribution ↔ wholesale`, and
  `contract_brewing → distribution | wholesale`. `taproom` is never a source or
  target; `contract_brewing` is never a target.

## Task Table

| # | Task | Files | Model |
|---|---|---|---|
| 1 | Migration: audit trigger + `edit_reason` | 1 | Haiku |
| 2 | `shipmentEdit.ts` — pure guard logic | 2 | Sonnet |
| 3 | Reversible commitment fulfillment | 2 | Sonnet |
| 4 | `PATCH /api/production/shipments/[id]` | 2 | Sonnet |
| 5 | `EditShipmentModal` + ShipmentsTab wiring | 2 | Sonnet |

---

## Task 1: Migration — audit trigger + `edit_reason`

**Files:**
- Create: `supabase/migrations/<YYYYMMDDHHMMSS>_export_transaction_edit.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `export_transactions.edit_reason text` (nullable); an
  `audit_export_transactions` row-level trigger feeding `public.audit_log`.

- [ ] **Step 1: Pick a non-colliding stamp**

Run `ls supabase/migrations/` and choose a full `YYYYMMDDHHMMSS` stamp later
than `20260905090000`. Confirm no existing file shares the digits before the
first `_`. Note the collision guard grandfathers known duplicates, so a clean
CI run does not prove absence of a collision — check by eye.

- [ ] **Step 2: Write the migration**

Two statements, plus a header comment explaining that the trigger closes a gap
left when `export_transactions` replaced `batch_exports` in
`20260622_export_transactions.sql` (the old table had `audit_batch_exports`;
it was not carried over).

```sql
alter table public.export_transactions
  add column if not exists edit_reason text;

drop trigger if exists audit_export_transactions on public.export_transactions;
create trigger audit_export_transactions
  after insert or update or delete on public.export_transactions
  for each row execute function public.audit_trigger_fn();
```

Acceptance: idempotent (`if not exists` / `drop ... if exists`), no data
backfill, no changes to any other table.

- [ ] **Step 3: Verify no collision and commit**

```bash
ls supabase/migrations/ | sort | tail -5
```

Expected: the new file sorts last and its digit prefix is unique.

```bash
git add supabase/migrations/
git commit -m "feat(production): audit trigger + edit_reason on export_transactions"
```

**Do NOT apply this migration.** Hand the file path to the user at the end.

---

## Task 2: `shipmentEdit.ts` — pure guard logic

**Files:**
- Create: `lib/production/shipmentEdit.ts`
- Test: `lib/production/shipmentEdit.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no I/O, no Supabase import).
- Produces:

```ts
export type EditableChannel = "distribution" | "wholesale" | "contract_brewing";

export interface ShipmentEditRow {
  id: string;
  channel: string;
  status: string;
  invoice_id: string | null;
  is_phantom: boolean | null;
  allocation_id: string | null;
}

export interface ShipmentEditPatch {
  channel?: string;
  recipient_id?: string | null;
  recipient_name?: string | null;
  notes?: string | null;
  edit_reason?: string | null;
}

export type ShipmentEditPlan =
  | { ok: false; error: string }
  | {
      ok: true;
      updates: Record<string, unknown>;
      allocationsToRecheck: string[];
      clearsCredits: boolean;
    };

export function planShipmentEdit(
  rows: ShipmentEditRow[],
  patch: ShipmentEditPatch,
): ShipmentEditPlan;

export function isShipmentEditable(rows: ShipmentEditRow[]): boolean;

export function allowedTargetChannels(currentChannels: string[]): EditableChannel[];
```

**Semantics:**

- `updates` is the column set applied to **every** row in the shipment. When
  `clearsCredits`, it also carries `allocation_id: null` and
  `over_allocation: false`.
- `clearsCredits` is true iff at least one row has a non-null `allocation_id`
  **and** the target channel is not `contract_brewing`. It keys off
  `allocation_id`, **not** off the row's channel — a crediting-mode shipment can
  hold a credited row whose channel is a soft channel.
- `allocationsToRecheck` is the de-duplicated non-null `allocation_id` set,
  empty when `clearsCredits` is false.
- `allowedTargetChannels` returns `["distribution", "wholesale"]` for any input
  set drawn from `distribution`/`wholesale`/`contract_brewing`, and `[]` if the
  set contains `taproom`.
- `isShipmentEditable` mirrors G1, G2, G3, G6 only (the row-state guards a
  client can evaluate without knowing the target).

**Guards** — each returns `{ ok: false, error }` with a distinct, operator-readable message:

| # | Condition |
|---|---|
| G1 | any row has non-null `invoice_id` |
| G2 | any row `status` is `unpaid` or `paid` |
| G3 | any row `channel` is `taproom` |
| G4 | target channel is `taproom` |
| G5 | target channel is `contract_brewing` |
| G6 | any row `is_phantom === true` |
| G7 | `recipient_id` present in patch and null/empty |
| G8 | no-op: every row already at target channel and no other field changed |
| G9 | `channel` change requested and `edit_reason` missing or blank |

Guard order matters only for message quality; evaluate row-state guards
(G1–G3, G6) before patch guards (G4, G5, G7–G9).

- [ ] **Step 1: Write the failing tests**

`lib/production/shipmentEdit.test.ts`, following the plain-`describe`/`it`
style of `lib/production/allocationReserve.test.ts` (no Supabase stub needed —
this module is pure). Local factory helpers for `ShipmentEditRow`.

Cases:
1. One rejection per guard G1–G9, asserting `ok === false` and a distinctive
   substring of each message.
2. `distribution → wholesale`: `ok`, `updates.channel === "wholesale"`,
   `clearsCredits === false`, `allocationsToRecheck === []`.
3. `wholesale → distribution`: same shape.
4. `contract_brewing → distribution` with two rows sharing `allocation_id "a1"`
   and one on `"a2"`: `clearsCredits === true`,
   `allocationsToRecheck` is `["a1", "a2"]` de-duplicated,
   `updates.allocation_id === null`, `updates.over_allocation === false`.
5. **Mixed-channel shipment** — rows `[{channel:"contract_brewing", allocation_id:"a1"},
   {channel:"distribution", allocation_id:null}]` → target `distribution`:
   accepted, both rows collapse to `distribution`, `clearsCredits === true`.
6. **Credited soft-channel row** — `{channel:"distribution", allocation_id:"a1"}`
   → target `wholesale`: `clearsCredits === true` and `a1` is rechecked.
   (Proves the flag keys off `allocation_id`, not channel.)
7. Recipient-only edit with no `channel` and no `edit_reason`: accepted (G9 is
   scoped to channel changes).
8. Notes-only edit with no `edit_reason`: accepted.
9. `allowedTargetChannels(["contract_brewing"])` → `["distribution","wholesale"]`;
   `allowedTargetChannels(["taproom"])` → `[]`;
   `allowedTargetChannels(["contract_brewing","distribution"])` →
   `["distribution","wholesale"]`. Never contains `taproom` or
   `contract_brewing`.
10. `isShipmentEditable` returns false for each of G1, G2, G3, G6 and true for a
    clean distribution shipment — and for every one of those row sets,
    `planShipmentEdit` also rejects, asserting the two agree.
11. Empty `rows` array → `{ ok: false }` (the route maps this to 404 separately).

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/production/shipmentEdit.test.ts
```

Expected: FAIL — cannot resolve `./shipmentEdit`.

- [ ] **Step 3: Implement `lib/production/shipmentEdit.ts`**

Pure module. No `@supabase/supabase-js` import. Module doc comment should state
that it is the single source of truth for edit legality, consumed by both the
route and the client, and explain why `clearsCredits` keys off `allocation_id`
rather than channel.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run lib/production/shipmentEdit.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add lib/production/shipmentEdit.ts lib/production/shipmentEdit.test.ts
git commit -m "feat(production): pure guard logic for shipment edits"
```

---

## Task 3: Reversible commitment fulfillment

**Files:**
- Modify: `lib/production/commitmentFulfillment.ts`
- Test: `lib/production/commitmentFulfillment.test.ts:1-` (extend; keep every existing case green)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:

```ts
export async function recheckCommitmentFulfillment(
  supabase: SupabaseClient,
  allocationId: string,
): Promise<void>;
```

`checkAndFulfillCommitment` keeps its exact current signature and external
behaviour — `writeColdStorageShipment` calls it and must not change.

**Refactor shape:** extract the shared read-and-compute half into a private
helper returning the decision inputs, then have both public functions consume
it:

```ts
type FulfillmentState = {
  commitmentId: string;
  status: string;
  exportedBbl: number;
  allocatedBbl: number;
} | null;   // null = any gate failed (no contract_request_id, batch not complete, producedBbl <= 0)
```

- `checkAndFulfillCommitment`: writes `fulfilled` iff
  `exportedBbl >= allocatedBbl` and `status !== "fulfilled"`. Unchanged.
- `recheckCommitmentFulfillment`: additionally writes `open` iff
  `exportedBbl < allocatedBbl` and `status === "fulfilled"`. No write otherwise.

`open` is the correct reversal target, not `brewing`: fulfillment only ever
fires once the batch is `complete`, so `brewing` is unreachable here. Document
this in the function's doc comment.

- [ ] **Step 1: Write the failing tests**

Extend `lib/production/commitmentFulfillment.test.ts`. **Reuse the existing
`stub(...)` helper verbatim** — it already dispatches reads by table name and
records `commitments.update` payloads, and the new function issues the same
query shapes (note its `export_transactions` branch terminates on the third
`.eq`).

Add a `describe("recheckCommitmentFulfillment")` block:

1. `fulfilled` → `open`: `commitment: { status: "fulfilled" }`, exports summing
   below `allocatedBbl`. Assert exactly one recorded update with payload
   `{ status: "open" }`.
2. No write when `status: "open"` and still below allocated.
3. No write when `status: "fulfilled"` and exported still ≥ allocated.
4. `open` → `fulfilled` on crossing up (parity with `checkAndFulfillCommitment`).
5. Batch not `complete` → no write in either direction.
6. No `contract_request_id` → no write.
7. `producedBbl <= 0` → no write.

Then assert the refactor preserved behaviour: **every pre-existing
`checkAndFulfillCommitment` case must still pass unmodified.** Do not edit them.

- [ ] **Step 2: Run tests to verify the new ones fail**

```bash
npx vitest run lib/production/commitmentFulfillment.test.ts
```

Expected: existing cases PASS; new `recheckCommitmentFulfillment` cases FAIL
with "recheckCommitmentFulfillment is not a function".

- [ ] **Step 3: Implement**

Extract the shared helper, add `recheckCommitmentFulfillment`, leave
`checkAndFulfillCommitment`'s behaviour identical.

- [ ] **Step 4: Run the full file plus the shipment writer's tests**

```bash
npx vitest run lib/production/commitmentFulfillment.test.ts lib/production/shipmentWriter.test.ts
```

Expected: PASS. `shipmentWriter.test.ts` is the regression gate on the
refactor — it exercises `checkAndFulfillCommitment` through the ship path.

- [ ] **Step 5: Commit**

```bash
git add lib/production/commitmentFulfillment.ts lib/production/commitmentFulfillment.test.ts
git commit -m "feat(production): make commitment fulfillment reversible"
```

---

## Task 4: `PATCH /api/production/shipments/[id]`

**Files:**
- Create: `app/api/production/shipments/[id]/route.ts`
- Modify: `lib/auth/__fixtures__/legacy-matrix.ts`

**Interfaces:**
- Consumes: `planShipmentEdit`, `ShipmentEditRow` (Task 2);
  `recheckCommitmentFulfillment` (Task 3).
- Produces: `PATCH /api/production/shipments/:shipmentId`.

**Contract:**

`id` is the `shipment_id`, not a row id. Request body matches
`ShipmentEditPatch`. Requires `CAP.exportOperate`.

| Outcome | Status | Body |
|---|---|---|
| Success | 200 | `{ updated: <row count>, rows: ExportTransaction[] }` |
| No rows for `shipment_id` | 404 | `{ error: "Shipment not found" }` |
| Guard rejection | 409 | `{ error: <guard message> }` |
| Supabase failure | 500 | `{ error: <message> }` |

**Sequence:**

1. `await requirePermission(CAP.exportOperate)` — follow the existing
   `try { … } catch (res) { return res as Response; }` idiom used across
   `app/api/production/**`.
2. `const { id } = await params;` — params is a `Promise` in this Next.js
   version (see `app/api/production/exports/[id]/route.ts:12`).
3. Select `id, channel, status, invoice_id, is_phantom, allocation_id` from
   `export_transactions` where `shipment_id = id`. Check `error`. Empty → 404.
4. `planShipmentEdit(rows, body)`. `ok: false` → 409 with the message.
5. One `.update(plan.updates).eq("shipment_id", id).select(...)`. Check `error`.
6. `for (const allocationId of plan.allocationsToRecheck) await recheckCommitmentFulfillment(supabase, allocationId);`
7. Return 200.

Step 5 is a single statement and therefore atomic on its own; step 6 is
idempotent and safely re-runnable, so Phase 1 needs no RPC or transaction
wrapper. Add a comment saying so, and noting that Phase 2's delete+insert will.

Use `createSupabaseServerClient` (session client) so `auth.uid()` populates
`audit_log.user_id`. Set `export const dynamic = "force-dynamic"`.

- [ ] **Step 1: Register the route in the auth fixture**

Add to `lib/auth/__fixtures__/legacy-matrix.ts`, adjacent to the existing
`production/exports/[id]` entries:

```ts
{ route: "production/shipments/[id]", method: "PATCH", legacy: ["brewer"], capability: "exportOperate" },
```

- [ ] **Step 2: Run the auth tests to see the fixture wired**

```bash
npx vitest run lib/auth
```

Expected: PASS (fixture entries are declarative; a missing route file does not
fail these).

- [ ] **Step 3: Implement the route**

Per the sequence above.

- [ ] **Step 4: Typecheck and lint**

```bash
npm run verify
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/production/shipments lib/auth/__fixtures__/legacy-matrix.ts
git commit -m "feat(production): PATCH route for editing a booked shipment"
```

---

## Task 5: `EditShipmentModal` + ShipmentsTab wiring

**Files:**
- Create: `app/production/components/EditShipmentModal.tsx`
- Modify: `app/api/production/exports/route.ts:11-21` (add `allocation_id` to the select)
- Modify: `app/production/components/ShipmentsTab.tsx`

**Interfaces:**
- Consumes: `allowedTargetChannels`, `isShipmentEditable`, `ShipmentEditRow`
  (Task 2); `PATCH /api/production/shipments/:id` (Task 4).
- Produces:

```tsx
export default function EditShipmentModal(props: {
  shipmentId: string;
  rows: ShipmentEditRow[];
  currentRecipientId: string | null;
  currentNotes: string | null;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element;
```

**Modal contents** — built from `Modal` / `Field` / `ModalActions`
(`app/components/ui/Modal.tsx`) and `Banner` (default export,
`app/components/ui/Banner.tsx`):

- **Channel** — `<select className="inp">` whose options come from
  `allowedTargetChannels(rows.map(r => r.channel))`, labelled with the existing
  `CHANNEL_LABELS` map in `ShipmentsTab.tsx`.
- **Customer** — `<select className="inp">` over `useContractPartnersQuery()`
  (`app/production/hooks/queries.ts:220`), showing `company_name`. Cannot be
  cleared (mirrors G7).
- **Notes** — optional `<textarea className="inp">`.
- **Reason for change** — `<input className="inp">`, required and submit-disabled
  while blank whenever the selected channel differs from the current one
  (mirrors G9).
- **Credit-release warning** — when `rows.some(r => r.allocation_id)`, a
  `<Banner tone="warning">`: *"This shipment currently credits N allocation(s).
  Changing its channel will release those credits and may reopen a fulfilled
  commitment."* with N the de-duplicated count.
- **Error** — `<Banner>` (default `danger` tone) carrying the API's `error`
  string verbatim, so guard messages reach the operator.

On submit: `PATCH`, then `onSaved()`. The parent closes and calls
`qc.invalidateQueries({ queryKey: queryKeys.production.exports() })` — the key
the tab already reads, so no new query key.

**ShipmentsTab changes:**

1. Add `rows: ShipmentRow[]` to the `InvoiceGroup` interface and push each raw
   row into it inside `groupByInvoice` (alongside the existing
   `product.allocations.push(...)`).
2. In the group header, after the status badge, render an **Edit** button
   (`className="btn-secondary btn-xxs"`) only when
   `isShipmentEditable(group.rows)`. Taproom day-groups never qualify (G3).
3. Track `const [editing, setEditing] = useState<InvoiceGroup | null>(null)` and
   render `EditShipmentModal` when set, passing
   `shipmentId={editing.rows[0].shipment_id}`.

A group keyed by `invoice_id` can span several `shipment_id`s, but G1 rejects
any invoiced shipment — so an editable group is always exactly one shipment and
`rows[0].shipment_id` is unambiguous. Add this as a code comment.

- [ ] **Step 1: Expose `allocation_id` to the client**

The tab cannot currently see `allocation_id` — neither the GET select nor the
`ShipmentRow` interface includes it, yet `isShipmentEditable` and the
credit-release warning both need it.

1. Add `allocation_id` to the select list in `app/api/production/exports/route.ts:11-21`
   (alongside the existing `recipient_id`).
2. Add `allocation_id: string | null;` to the `ShipmentRow` interface in
   `ShipmentsTab.tsx:24-51`.

`ShipmentRow` then satisfies `ShipmentEditRow` structurally (its `channel` and
`status` string-literal unions are assignable to `string`), so `ShipmentRow[]`
can be passed wherever `ShipmentEditRow[]` is expected with no mapping layer.

- [ ] **Step 2: Add `rows` to `InvoiceGroup` and populate it**

`ShipmentsTab.tsx` — interface at `:97`, population inside `groupByInvoice`
at `:217`.

- [ ] **Step 3: Typecheck**

```bash
npm run verify
```

Expected: PASS.

- [ ] **Step 4: Build `EditShipmentModal.tsx`**

Per the contents above. No raw colour utilities, no hand-rolled buttons or
inputs.

- [ ] **Step 5: Wire the Edit button and modal into ShipmentsTab**

- [ ] **Step 6: Verify**

```bash
npm run verify
```

Expected: PASS.

Then grep the two touched files for banned utilities — expected: no matches.

```bash
grep -nE "\b(zinc|amber|red|green|blue|gray)-[0-9]" app/production/components/EditShipmentModal.tsx app/production/components/ShipmentsTab.tsx
```

Note the pre-existing `accent-amber-500` on the selection checkbox at
`ShipmentsTab.tsx:623` will match. Leave it — it is out of scope and predates
this work.

- [ ] **Step 7: Commit**

```bash
git add app/production/components/EditShipmentModal.tsx app/production/components/ShipmentsTab.tsx app/api/production/exports/route.ts
git commit -m "feat(production): edit shipment channel/recipient/notes from Shipments tab"
```

---

## Final verification

- [ ] `npm run verify` passes from a clean tree.
- [ ] `lib/` coverage has not dropped below the `vitest.config.ts` threshold floor.
- [ ] Report the migration file path to the user for manual application. **Do
      not apply it.** Until it is applied, the `edit_reason` write will fail with
      `PGRST204` and the audit trigger will not fire.
- [ ] **Browser check, after the user applies the migration:** open Production →
      Shipments, edit a distribution shipment to wholesale, confirm the channel
      badge changes, then confirm an `audit_log` row exists for the
      `export_transactions` record carrying the old channel, new channel, and
      reason. Several recent merged features were never opened in a browser and
      shipped with visible defects — do not skip this.

## Deferred (not this plan)

- Phase 2, `→ contract_brewing`: spec §6.
- The unsafe, UI-unreferenced `app/api/production/exports/[id]/route.ts`
  (`DELETE` does not restore cold-storage inventory; `PATCH` sets `quantity`
  and `status` with no guards): spec §7.
