---
name: project_excise_channel_liability
description: "Excise tax liability differs by sales channel; invoice excise must be reported as actually-charged, never flat volume×rate"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6c2f1edf-b4e7-4aa4-89b6-5fdc830f5fda
---

Excise tax liability is **channel-dependent** in the finance reports:
- **Contract brewing & distribution** — TPB IS responsible for paying excise.
- **Wholesale** — TPB is NOT responsible (it's the buyer's liability).

Therefore invoice-side excise must be reported as **what was actually charged** (sum of `export_transaction_taxes` rows per shipment, bucketed NC vs Federal by `tax_name`), NOT recomputed flat as `volume_bbl × rate`. A flat calculation fabricates a nonexistent wholesale liability and misstates tax owed. Wholesale shows $0 excise (it legitimately has no `export_transaction_taxes` rows). Surface TPB-liable shipments that are missing recorded excise as a visible warning rather than guessing.

Implemented in `lib/finance/invoiceSalesReport.ts` (the ledger-backed `/api/finance/sales/invoices` route): excise summed from `export_transaction_taxes`; `exciseCoverage` field counts TPB-liable txns with volume but no excise detail; surfaced via `app/finance/sales/UnrecognizedBanner.tsx`.

**Known data gap (as of 2026-06-30):** only the Ship flow (`lib/production/exportTransactionWriter.ts` → `computeExciseTaxBreakdown`, which reads the configurable `excise_tax_rates` table) writes `export_transaction_taxes`. Other `export_transactions` creation/backfill paths set the aggregate `total_excise_tax_usd` but skip the per-rate detail rows — 49 of 58 linked txns lack detail. So `total_excise_tax_usd` is the only reliably-populated aggregate today, but it has no NC/Federal split. Fixing the writers + backfilling is future work (must be channel-aware: no wholesale liability).

**Future direction:** taproom auto-"shipping" (deriving shipments from POS transactions) is planned but the logic isn't worked out yet; once built, taproom excise will also live on `export_transaction_taxes`, unifying excise on that table.

**Why:** misattributing excise liability misstates tax owed — a financial/compliance risk. **How to apply:** never derive invoice excise from flat volume×rate; read actual charged amounts; wholesale = zero TPB excise; make missing detail visible, never silently fill it. Relates to [[project_three_channel_invoicing]].
