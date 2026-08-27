---
name: project-shipment-channel-billing-exceptions
description: "2026-07-24: Export invoice can be billed under a different channel than shipped (billing exceptions) — invoice-time override, no shipment/commitment mutation. PR #260 OPEN."
metadata: 
  node_type: memory
  type: project
  originSessionId: fbf35949-6f1d-454f-a01e-6b442b2cdf26
  modified: 2026-07-24T19:17:31.761Z
---

2026-07-24: Added a billing-exception path so an Export shipment can be **invoiced under a different channel/model** than it was shipped under (e.g. Fortnight pumpkin-ale canning shipped `distribution`, billed `contract_brewing` with the manual invoice config), without accepting upstream commitments or altering the shipment record.

**Design = invoice-time override ONLY** (not a persistent reclassification). The invoice line-item branch is chosen purely by a channel value; we thread an optional `billAsChannel` through `buildInvoicePreview` (new `resolveInvoiceChannel` helper) that overrides the value read from `export_transactions.channel`. Nothing writes `export_transactions.channel` or calls `checkAndFulfillCommitment` — key finding: **commitment acceptance is a ship-time concern, fully decoupled from invoicing** (invoice routes never touch `commitments`).

**Two independent excise systems** (verified in code): invoice excise (pass-through line) reads only `export_transaction_taxes` and returns `[]` with no rows — never fabricated from the billed channel; excise LIABILITY (NC DOR B-C-710, `lib/tax/parties/ncDorBeerExcise/calc.ts`) reads only `export_transactions.channel`, so the override can't change what TPB remits. Taxable = distribution/contract_brewing/taproom; wholesale = Line 4a deduction (`rates.ts`). New pure `crossesExciseTreatmentBoundary` flags the one risky case (wholesale⇄taxable) with a red in-modal warning.

**Governance:** reason note REQUIRED (server-enforced) when billed≠shipped; invoice persists both `shipped_channel` + `billed_channel` + `override_reason`. No role gate (per user). Reports can flag off-model via `billed_channel IS DISTINCT FROM shipped_channel`.

**Files:** `lib/production/exportInvoicePreview.ts` (resolveInvoiceChannel + billAsChannel + shippedChannel), `app/api/production/export/invoice-preview/route.ts` (billAs param+validate), `app/production/hooks/queries.ts` (useInvoicePreview 2nd arg), `app/api/production/export/invoice/route.ts` (derive shippedChannel server-side, require reason, persist cols), `app/production/components/InvoicePreviewModal.tsx` (Bill-as selector, reason, off-model + excise banners), `rates.ts` helper.

**PR #260 MERGED 2026-07-24; worktree + branch CLEANED.** ⚠️ **STILL PENDING: apply human-gated migration `20260815_invoice_channel_override.sql`** (3 nullable cols on `invoices`) to prod — merged to main but NOT yet applied (renumbered off 20260814 which #257 claimed). Final Opus review passed all 6 invariants; its 3 findings fixed (reset lines on channel switch via onChange not effect — repo lint forbids setState-in-effect; render Bill-as selector in preview-error branch so mixed-channel selection can be rescued; validate billAs in preview route). Merged main (#259) mid-review: conflict was #259's new `packagingFeeDescription` helper added at the same insertion point in exportInvoicePreview.ts + its test — resolved by keeping BOTH helpers/describe blocks; post-merge verify green (1845). Browser E2E of core flow done. Design/plan under `docs/superpowers/{specs,plans}/2026-07-23-shipment-channel-billing-exceptions*`.

Related: [[project_excise_channel_liability]], [[project_three_channel_invoicing]], [[project_invoice_line_item_unification]].
