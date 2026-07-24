# Shipment Channel Billing Exceptions — Design

**Date:** 2026-07-23
**Status:** Approved (design), pending implementation plan
**Area:** Production → Export → Shipments → Generate Invoice

## Goal

Let an operator bill an already-shipped shipment under a **different channel/model** than it was shipped under, as a one-off exception — e.g. Fortnight Brewing's pumpkin-ale canning shipment (shipped as `distribution`) needs to be billed under a **contract_brewing** model, generating the standard contract-brewing base invoice and then adding extra line items via the manual invoice configuration — **without** accepting any upstream commitments and **without** altering the shipment record or excise reporting.

## Key finding that shapes the design

Two properties of the existing code make this safe and small:

1. **Commitment acceptance is fully decoupled from invoicing.** `checkAndFulfillCommitment` (`lib/production/commitmentFulfillment.ts`) marks a `commitments` row `fulfilled` **only at ship time**, and only when a shipment row carries an `allocation_id`. The invoice routes never touch commitments. Generating any invoice against an already-shipped row therefore carries **zero** risk of accepting a commitment, regardless of channel.
2. **The invoice line-item branch is chosen purely by a channel value.** `buildInvoicePreview` (`lib/production/exportInvoicePreview.ts`) reads `export_transactions.channel` and branches to a per-channel line-item builder. Supplying an *effective billing channel* that overrides that read is enough to reroute the invoice model, touching nothing else.

## Decisions (locked with the user)

- **Blast radius: invoice-time override only.** The override changes only the generated invoice's line-item logic. `export_transactions.channel` is **never** mutated, so excise reporting, sell-through, and Shipments-list grouping are untouched.
- **Base content: full contract_brewing base, excise best-effort.** When overriding to contract_brewing, auto-build packaging fees + keg-cleaning + forklift + excise. Excise is best-effort: it is sourced from `export_transaction_taxes` rows recorded at ship time; if none exist, no excise line appears (never synthesized).
- **Governance:** (a) a **reason note is required** when billed-as ≠ shipped-as, stored on the invoice; (b) the invoice record persists **both** the shipped-as and billed-as channel so reports can flag off-model invoices. **No role restriction** (per user; invoice generation already lives behind the normal Production access path).

## Approach (chosen)

**Server preview override + modal control.** `buildInvoicePreview` accepts an optional `billAsChannel`; the Generate Invoice modal gains a "Bill as" selector, a reason field, and boundary warnings; the invoice record stores `shipped_channel` / `billed_channel` / `override_reason`. The stored shipment row is never written.

Rejected alternatives:
- **Client-only override** — impossible; the contract_brewing base (packaging fees, keg-cleaning, forklift, excise) is built server-side from `invoice_item_mappings`, recipe data, and `export_transaction_taxes`. The client cannot reconstruct it.
- **Separate "manual invoice from scratch" entry point** — more UI surface and discards the auto-built base the user wants. It is just the chosen approach with extra steps.

## The two independent excise systems (why invoice-time override is safe)

| System | What it is | Reads from | Changed by override? |
|---|---|---|---|
| **Invoice excise** | Excise line *charged to the partner* on the bill | `export_transaction_taxes` only (`exportInvoicePreview.ts:71-75`) | Which branch runs, yes |
| **Liability excise** | What TPB *owes NC DOR* (Form B-C-710) | `export_transactions.channel` + `volume_bbl` (`lib/tax/parties/ncDorBeerExcise/calc.ts:73`) | **No — never reads `invoices`** |

Channel excise treatment (`lib/tax/parties/ncDorBeerExcise/rates.ts:23-30`): `distribution`, `contract_brewing`, `taproom` are **taxable** (TPB owes); `wholesale` is a **Line 4a deduction** (TPB owes nothing).

Because the liability report reads only the stored channel, the override cannot change what TPB remits to the state. And because `buildExciseTaxLines` returns zero lines when no `export_transaction_taxes` rows exist (no volume×rate fallback), the override can only surface excise that was already recorded at ship time — it never fabricates a charge from the billed channel.

### Per-scenario consequence

- **Shipped distribution → billed contract_brewing** (the Fortnight canning case): detail rows already exist → invoice charges the same excise TPB reports owing. **Zero divergence** (only the report's internal bucket label stays "distribution"; same rate, same total). Safe.
- **Shipped contract_brewing/distribution → billed wholesale**: wholesale branch adds no excise line → partner not charged, but TPB still reports owing → TPB absorbs the excise. Margin leak, not a compliance problem.
- **Shipped wholesale → billed contract_brewing** (the only risky one): wholesale ships usually have no detail rows → auto-excise is $0 and stays consistent. A gap opens **only if an operator manually adds an excise charge** — then the partner is charged excise that TPB's report deducts and never remits. The boundary warning (below) targets exactly this.

## Components / changes

### 1. `lib/production/exportInvoicePreview.ts` — `buildInvoicePreview(txns, opts)`
- Add optional `opts.billAsChannel`. When set, use it as the effective channel for the branch (currently `~:248-364`) instead of deriving from the rows.
- Relax the single-channel guard (`~:192-197`): **no override** → rows must share one stored channel (unchanged); **override present** → any mix of stored channels is allowed. The single-**customer** guard stays enforced in both cases.
- Return both `shippedChannel` (original stored channel; `"mixed"` if rows differ) and `channel` (effective / billed).
- Excise best-effort is inherent: the contract_brewing branch calls `buildExciseTaxLines`, which returns `[]` when no `export_transaction_taxes` rows exist. Confirm it degrades (returns empty) rather than throwing for overridden rows.

### 2. Preview fetch + `app/api/production/export/invoice/route.ts`
- Thread `billAsChannel` through the preview request (`useInvoicePreview`) so the base rebuilds when the operator changes "Bill as".
- The `generate` and `record` actions accept `bill_as_channel`, `shipped_channel`, and `override_reason`, and persist them on the `invoices` row. Validation: if `bill_as_channel` differs from `shipped_channel`, `override_reason` must be non-empty (server-enforced, not just client).

### 3. `app/production/components/InvoicePreviewModal.tsx`
- **"Bill as" selector**, defaulting to the shipment's stored channel. Changing it re-fetches the preview with `billAsChannel` and rebuilds the base line items. Options limited to invoiceable channels (`distribution`, `contract_brewing`, `wholesale`); `taproom` excluded.
- **Reason field**, shown and required only when billed-as ≠ shipped-as; Generate/Record stays disabled until it is filled.
- **Off-model banner** when billed-as ≠ shipped-as: "Shipped as *X*; billing as *Y*."
- **Excise boundary warning** — when billed-as and shipped-as fall in *different* excise-treatment classes (one in the taxable set `{distribution, contract_brewing, taproom}`, the other being `wholesale`): show the pointed warning:
  > "This shipment is reported to NC DOR as *wholesale* (non-taxable). Billing it as *contract_brewing* does not change TPB's excise liability. Do not add an excise charge unless you also intend to reclassify the shipment for tax reporting."
  Same-class overrides (e.g. distribution↔contract_brewing) show no excise warning. The check reuses the sets already exported from `ncDorBeerExcise/rates.ts`.
- Existing Square/Manual toggle and line add/edit/remove are unchanged — that is the "add items on top" + "record via manual config" path.

### 4. Schema — new `supabase/migrations/` file
- Add three **nullable** columns to `invoices`: `billed_channel text`, `shipped_channel text`, `override_reason text`.
- Nullable → existing invoices and non-override invoices are unaffected. Reports can flag off-model invoices with `billed_channel IS DISTINCT FROM shipped_channel`.
- New migration file only; do not hand-edit existing migrations.

## Explicitly NOT touched

- `export_transactions.channel` (never written by the invoice path).
- `checkAndFulfillCommitment` / `commitments` (ship-time only; invoice path never calls it).
- All channel-keyed reporting: NC DOR beer-excise liability (B-C-710), sell-through, Shipments-list grouping/labels. These read the stored channel, which the override leaves intact.

## Testing

- **`lib/production/exportInvoicePreview.test.ts`** (co-located, required by repo rule):
  - `billAsChannel` reroutes the branch: rows stored `distribution`, `billAsChannel: "contract_brewing"` → contract_brewing base lines (packaging/keg-cleaning/forklift) are produced.
  - Excise best-effort: overridden rows **with** `export_transaction_taxes` → excise line present with the recorded amount; **without** → no excise line, no throw.
  - Mixed stored channels + override → allowed; mixed stored channels + no override → still throws.
  - Single-customer guard still throws on mixed customers regardless of override.
  - Return shape includes both `shippedChannel` (or `"mixed"`) and effective `channel`.
- Server route: `record`/`generate` reject an override with an empty `override_reason`.

## File touch map

- `lib/production/exportInvoicePreview.ts` (override param, guard relaxation, return shape)
- `app/api/production/export/invoice/route.ts` (+ preview endpoint / `useInvoicePreview` fetch) — thread + persist override fields
- `app/production/components/InvoicePreviewModal.tsx` (Bill-as selector, reason field, off-model + excise-boundary warnings)
- `supabase/migrations/<new>.sql` (nullable `billed_channel` / `shipped_channel` / `override_reason` on `invoices`)
- `lib/production/exportInvoicePreview.test.ts` (override branch coverage)

## Open items / caveats to carry into the plan

- Confirm the exact preview transport for `useInvoicePreview` (GET vs action POST) so `billAsChannel` is threaded on the real endpoint.
- UI must use token utilities / existing primitives (`<Banner>`, `.inp`, `<Field>`, `<Modal>`), per `docs/UI_STANDARD.md` — no raw colors, no hand-rolled controls.
- The migration is **human-gated**: applied to prod only after explicit user OK.
