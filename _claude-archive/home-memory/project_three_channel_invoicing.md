---
name: project-three-channel-invoicing
description: "Three-channel invoicing rework — SHIPPED and merged to main 2026-06-27. Wholesale channel, recipe_square_links format column, export invoice branching by channel."
metadata: 
  node_type: memory
  type: project
  originSessionId: 7130e305-7542-4ace-889d-cff195874c93
---

**Status: MERGED to main (2026-06-27)**

Adds `wholesale` as a third export channel alongside `contract_brewing` and `distribution`. Export invoices now branch by channel: contract brewing is unchanged; distribution gets Square product lines + excise tax + distribution_discount; wholesale gets Square product lines + wholesale_discount only (no excise tax, no deposit invoice).

**Why:** Three distinct sales models need different invoicing behaviour.

**What shipped:**
- Migration `20260627_three_channel_invoicing.sql`: wholesale added to CHECK constraints on `commitments`, `batch_allocations`, `export_transactions`; `distribution_discount`/`wholesale_discount` added to `invoice_item_mappings.service_type`; `packaging_format` column + two partial unique indexes on `recipe_square_links`
- `buildInvoicePreview()` in `lib/production/exportInvoicePreview.ts`: channel-branched with `buildProductLines()` helper doing `recipe_square_links` lookup by `(recipe_id, packaging_item_id, packaging_format)` key
- `SquareLinkManager` UI: Format dropdown for can-type packaging items; quick-add generates 4-pack + case rows by default
- `CommitmentsTab`: wholesale as third channel option (amber color chip); deposit invoice early-return updated
- `ExportBayTab`: wholesale added to ad-hoc channel select
- `ExportSettingsPanel`: `DistributionDiscountSection` and `WholesaleDiscountSection` added
- `recipe-square-links` API: POST validates can links require format, kegs must not have it
- Allocations API POST: explicit channel allowlist includes wholesale

**Known deferred (non-blocking):**
- Missing-link error in `buildProductLines` shows packaging_item UUID instead of display name
- Excise tax query block duplicated between contract_brewing and distribution branches in exportInvoicePreview.ts
- Wholesale color is amber (spec suggested teal "or similar")

**How to apply:** Feature is live. When touching export invoice logic, channel branching is in `lib/production/exportInvoicePreview.ts`. When touching discount config, `SERVICE_TYPES` and `DISCOUNT_TYPES` constants are both in `app/api/production/export-settings/service-mappings/route.ts`.
