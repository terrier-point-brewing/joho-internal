# TPB Square Reports — Handoff Document

## What This Is

A Next.js 16 app deployed to Vercel that generates custom reports for **Terrier Point Brewing** by hitting the Square API. Single location: **Holly Springs Taproom** (`LZ8TH4A632YW0`). Dark mode UI, publicly accessible.

**Live URL:** https://tpb-square-reports.vercel.app  
**Repo:** `/Users/will-liao/Desktop/Coding/Git/tpb-square-reports`  
**Deploy:** `vercel deploy --prod` from the repo root

---

## Environment Variables

Stored in `.env.local` (local) and in Vercel project settings (production).

```
SQUARE_ACCESS_TOKEN=EAAAl_uGNlwbvUjkHXVwW9ms3hh8GqMnxTQe1Tog3fEZi_LwN9ba7Xnaqq5UhBVI
SQUARE_LOCATION_ID=LZ8TH4A632YW0
```

Square Application ID (not used in code, for reference): `sq0idp-Ilv-Dj0we6EVitajSRyzfA`

---

## Tech Stack

- **Next.js 16.2.6** (App Router, TypeScript, Tailwind v4)
- **Square API** version `2025-04-16` — called directly via `fetch`, no Square SDK
- **Recharts** — used only in the Shrinkage report line chart
- **Vercel** for hosting

---

## Project Structure

The app is organized as **modules**. Each module is a top-level route under `app/`. Adding a new module means creating `app/<module>/page.tsx` and adding one entry to `MODULES` in `app/components/NavBar.tsx`.

```
app/
  layout.tsx                    — html/body shell + NavBar (global)
  page.tsx                      — server redirect → /reports
  globals.css                   — dark mode base styles (zinc-950 background)
  components/
    NavBar.tsx                  — module tab navigation (Reports / Production)

  reports/                      — Reports module
    page.tsx                    — report category + report selector, renders active report
    components/
      ReportControls.tsx        — shared date range + group-by controls + run/export buttons
      SortControls.tsx          — useSort<T> hook + SortTh component (sortable column headers)
      CocktailSalesReport.tsx
      KegSalesReport.tsx
      TaproomModelReport.tsx
      GiftCardReport.tsx
      ContractBrewingReport.tsx
      DistributionReport.tsx
      BBLTrackerReport.tsx
      ShrinkageReport.tsx

  production/                   — Production module (placeholder, ready to build out)
    page.tsx

  api/                          — API routes (flat, all reports)
    cocktail-sales/route.ts
    keg-sales/route.ts
    taproom-model/route.ts
    gift-cards/route.ts
    contract-brewing/route.ts
    distribution/route.ts
    bbl-tracker/route.ts
    shrinkage/route.ts
    combo-sales/route.ts        — legacy, not used by UI but kept for backwards compat

lib/
  square/
    client.ts                   — squareGet, squarePost, squareGetAll, squarePostAll (paginated)
    catalog.ts                  — fetchCatalogItems, buildStandalonePriceMap, buildVariationNameMap
    orders.ts                   — fetchCompletedOrders (POS, COMPLETED only), fetchInvoiceOrders (OPEN+COMPLETED)
    customers.ts                — fetchCustomers (parallel), customerDisplayName
    refunds.ts                  — fetchRefunds
    inventory.ts                — fetchPhysicalCounts (PHYSICAL_COUNT changes, paginated)
  constants/
    categories.ts               — all Square reporting category IDs, TAPROOM_MODEL_CATEGORIES,
                                  CONTRACT_BREWING_SUBCATEGORY_LABELS, classifyContractBrewingItem()
  reports/
    combos.ts                   — buildComboIndex, buildComponentIndex, detectComboSales → ComboSale[]
    cocktails.ts                — detectCocktailSales → { sales: CocktailSale[], comboClaimedKeys }
    kegs.ts                     — buildKegIndex, detectKegSales → KegSale[]
    taproom-model.ts            — buildTaproomModelReport → TaproomModelResult
    contract-brewing.ts         — buildContractBrewingReport → { byCategory, byCustomer }
    distribution.ts             — buildDistributionReport → { bySize, byCustomer }
    bbl-tracker.ts              — buildBBLTrackerReport → { byStyle, byChannel, totalExciseTax }
    shrinkage.ts                — buildShrinkageReport → { draft, liquor, chartData }

types/
  square.ts                     — Square API shapes (Order, OrderLineItem, CatalogItem, etc.)
  reports.ts                    — ComboSale, CocktailSale, KegSale, TaproomModelResult, etc.
```

---

## UI Conventions

### Report selector
Two dropdowns: **Category** (Net Sales Reports / Sales Reports / Production / Inventory Management) then **Report** (filtered to that category). Date range persists across report switches — start/end state lives in `reports/page.tsx` and is passed as props to each report component.

| Category | Reports |
|---|---|
| Net Sales Reports | Taproom, Contract Brewing, Distribution |
| Sales Reports | Cocktail Sales, Keg Sales, Gift Card Sales |
| Production | BBL Tracker |
| Inventory Management | Shrinkage |

### Sortable columns
Every report table has sortable column headers via `SortTh`. Click a header to sort ascending (↑), click again to flip (↓), dimmed ↕ when unsorted. Reports with multiple sub-tables have independent sort state per table. To add sort to a new table:
```tsx
const { sorted, sortKey, sortDir, handleSort } = useSort(rows);
const sp = { sortKey, sortDir, onSort: handleSort };
// Replace <th> with <SortTh label="..." col="fieldName" {...sp} />
// Render sorted ?? rows instead of rows
```

---

## Reports

### 1. Cocktail Sales (`/api/cocktail-sales`)
Detects two types of cocktail sales:
- **COMBO cocktails** (product_type=COMBO in Cocktails reporting category): identified by comparing the component line item's charged price vs its standalone catalog price — the combo's fixed price overrides the component price, creating a price discrepancy. The combo has multiple component line items (one per slot) which are aggregated into one row per combo per order.
- **Non-combo cocktails** (FOOD_AND_BEV in Cocktails category, e.g. Passionfruit Kiwi Margarita): identified directly by variation ID.

Key nuance: Square stores COMBO sales as the component items in the Orders API — the COMBO's own variation ID **never appears** in order line items.

Group-by: Date (transaction rows) or Item (aggregated totals).

### 2. Keg Sales (`/api/keg-sales`)
Items in Kegs reporting category with variation names matching `\d+/\d+ Keg` (excludes Keg Deposit, Pump Deposit).

Key nuance: the `Keg Transfer (Set 660oz to Draft)` discount flags a keg as an internal draft transfer, not a customer sale. Transfers shown with amber badge, excluded from money totals.

Group-by: Date / Beer / Beer + Size.

### 3. Taproom (`/api/taproom-model`)
10 categories: Draft Beer, Liquor, Wine/Cider/Seltzers, Cocktails, NA/Snacks, Kegs, Cans, Merchandise, CO2, Other.

Key nuances:
- **Invoice orders excluded** (`source.name === "Invoices"`)
- **Cocktail combo components** attributed to Cocktails (not Liquor/Draft) via `comboClaimedKeys`
- **Keg transfers** excluded from Kegs gross
- **Gift cards** caught by `item_type === "GIFT_CARD"` → Other
- **Returns** proportionally distributed from `/v2/refunds`
- **Tips** from `order.total_tip_money` — shown as callout
- **Taproom Attributed Net Sales** callout — sum of Net Sales for all categories except CO2 and Other

### 4. Gift Card Sales (`/api/gift-cards`)
Scans completed orders for `item_type === "GIFT_CARD"` line items. Shows discount reason in Discount Notes column. Comped cards (net=$0) are visually dimmed.

### 5. Contract Brewing (`/api/contract-brewing`)
Invoice orders (OPEN + COMPLETED) containing items in the **Contract Brewing** category (`CDX2UMLF35B4I3F7ILYLMWMF`).

Sub-categories via `classifyContractBrewingItem()`:
- **Materials & Packaging**: Ingredient Deposit, Packaging Materials
- **Packaging Fees**: Packaging Fee
- **Pass-Through Taxes**: Barrel Excise Tax (anything with "tax" in name)
- **Other Services**: Keg Cleaning Service, Forklift Fee, everything else

By-customer table shows # Invoices, Total Charged, Outstanding (`net_amount_due_money`). Outstanding amounts are amber-highlighted.

**Customers in the data:** Argus Beverage Ventures LLC, Local Time Brewing, Fortnight Brewing.

### 6. Distribution (`/api/distribution`)
Invoice orders (OPEN + COMPLETED) containing items in Kegs or Cans categories. Revenue by keg size; customer table with per-size qty columns. Currently only Fortnight Brewing has distribution invoices.

### 7. BBL Tracker (`/api/bbl-tracker`)
Tracks beer production volume in BBLs by style and distribution channel. Uses both POS and invoice orders.

**Channels:**
- `TAPROOM_DRAFT` — keg transfers (Keg Transfer discount on POS orders)
- `TAPROOM_PACKAGED` — taproom keg/can sales (non-transfer POS)
- `DISTRIBUTION` — invoice orders with keg/can items, no contract brewing items
- `CONTRACT_BREWING` — invoice orders with keg/can items AND contract brewing items

**Volume constants:**
- 1/2 Keg = 15.5 gal, 1/4 Keg = 7.75 gal, 1/6 Keg = 5.167 gal
- Cans: oz parsed from variation name (e.g. "16oz 4-Pack" = 64oz)
- 1 BBL = 31 gallons

**Excise tax:** NC state $0.6171/gal + Federal $3.50/BBL

**Contract brewing volume nuance:** Contract brewing invoices use a generic `Packaging Fee` catalog item (in the Contract Brewing category) rather than the beer-specific keg catalog items. The keg size is in `variation_name` ("1/2 Keg", "1/6 Keg") and the beer name is in the line item `note` field (e.g. "Epic Hazy IPA"). `buildCatalogIndex` indexes these Packaging Fee variation IDs separately (`packagingFeeKegVars`), and volume is attributed by matching the note against draft catalog item names (case-insensitive). Lines with no note are skipped. This is implemented in `lib/reports/bbl-tracker.ts`.

Can sizes: most beers 16oz; BBA/Groundhog Imperial Stouts 12oz. Sold as single, 4-Pack, or Case (24).

### 8. Shrinkage (`/api/shrinkage`)
Uses `POST /v2/inventory/changes/batch-retrieve` with `types: ["PHYSICAL_COUNT"]` (paginated).

**Draft** = items in Draft reporting categories.  
**Liquor** = items in Bourbon/Whiskey/Tequila/Rum/Vodka/Gin categories.

Quantities in fl oz: full 1/6 keg ≈ 660 fl oz; 750ml spirit = 25.4 fl oz, 1L = 33.8 fl oz.

**Shrinkage % per period** = `(prev_count - current_count) / prev_count × 100`. Increases (restocks) → `null`.

Line chart (Recharts): x=ISO week, y=% depletion. Sparse until staff record regular weekly counts.

---

## Square Catalog Category IDs

All IDs in `lib/constants/categories.ts`. Second ID in each pair is the Holly Springs Taproom sub-location variant.

| Business Category | Square Category Name | ID(s) |
|---|---|---|
| Draft Beer | Draft | `567KQPEBRBZHG7ATHQFRCRWZ`, `DCPYMNVDYNX4JAFI22DMVKLN` |
| Kegs | Kegs | `FXHTXXAICGRPMGJAHGJZ34MY`, `L47I4EF3LKJOSWUH47C5JNDA` |
| Cans | Cans | `Q5BMUOAOCBOUS4JNDRAAXA4Q`, `TSRMBVP2CWAHLZO4DFTXAQ7Q` |
| Cocktails | Cocktails | `IPD6T7FOCCZBXG2HOPOVFB4J`, `UE65PMYDYAA3GZVZZE2QXTEF` |
| Bourbon | Bourbon | `HN4WYDVIFBWTS6XZQVCS3PV7`, `J6KQFWSAHICHKE7VUFLCSK6O` |
| Whiskey | Whiskey | `BRCNBA7EQUJTERWY6DPCPATH`, `4Y35NEUUJ5G6NTRPIDY62NZH` |
| Tequila | Tequila | `DMN6KPKKAPSD5ACKII4XL6MB`, `SSZBQ7F3XLUMSJKOFETT7J3E` |
| Rum | Rum | `ZDO2A6BY6436YKU2OYANKTOE`, `RAUBCOON66IN5TWMKAMC3SQQ` |
| Vodka | Vodka | `JE4SAYBBE6XW2W6QKCJ2N3RT`, `CNN2QQJUWZNXFRUATKNXUSA5` |
| Gin | Gin | `A5M5IAD2IKGX56SQ3JV7JUTG`, `WK3DXHBWSDFMW6E3G3MEODRM` |
| Wine | Wine | `LZTB6W2YCUEHXEBBMIGRJFTA` |
| Cider | Cider | `LF2BURFOKACF7PGNVNKDNBI4` |
| Seltzer | Seltzer | `QXDCEF4UVD5GV4EJMEF4RH5V` |
| NA/Snacks | Non-Alcoholic | `SQU43MD34LLCGW4ELQ2HSPPD` |
| NA/Snacks | Snacks | `VS5QIJ7EH56OXJ3OOMNCJVHP` |
| NA/Snacks | Prepared | `YS27WNLY4BAGJDIS66WLBHQX` |
| Merchandise | Merchandise | `QDY242ULK5TF5GNWOSOZ2KG4`, `KX4N5F4WGSI7VMYUL3ZXJQVM` |
| CO2 | Tank Fills | `6M5K5FSUDGPCMGIC7BOUDAK2` |
| Other | Deposits | `3Y5UG43QKQ6DD2BCSVKECCQL` |
| Contract Brewing | Contract Brewing | `CDX2UMLF35B4I3F7ILYLMWMF` |

---

## Square Data Quirks

### COMBO Items
Square's `product_type=COMBO` items do **not** appear in order line items as the combo's own variation ID. Instead, the component items appear with their own catalog IDs — but charged at the combo's fixed price (not their standalone price). The price discrepancy is the only reliable signal that a component was sold as part of a combo. Multi-component combos (e.g. Citrus Wheat Wave = Deep Eddy Lemon + Carolina Wheat Wave) produce multiple line items per sale that must be aggregated.

### Order Sources
- `source.name === "Point of Sale"` — Square POS app
- `source.name === ""` (empty) — Square Register / handheld hardware
- `source.name === "Invoices"` — Square Invoices (wholesale, contract, distribution) → excluded from Taproom report

### Keg Transfers
A keg "sold" to convert it from packaged inventory to draft is identified by the `Keg Transfer (Set 660oz to Draft)` discount (100% discount, total_money = $0). These appear as COMPLETED orders with the Keg Transfer discount.

### Packaging Fee Line Items on Contract Brewing Invoices
Contract brewing invoices charge customers using a generic `Packaging Fee` catalog item (Contract Brewing category) rather than the actual beer keg catalog items. The keg size lives in `line.variation_name` ("1/2 Keg", "1/6 Keg") and the beer name lives in `line.note` ("Epic Hazy IPA", "Carolina Pale Ale"). The BBL tracker resolves this by maintaining a separate `packagingFeeKegVars` index and matching notes against draft catalog item names. Lines without a note are skipped entirely.

### Inventory Physical Counts
Liquor tracked in fl oz (decimal quantities like 25.4). Draft kegs currently tracked in whole-unit integer counts — fl oz keg tracking not yet fully deployed. Fetched via `POST /v2/inventory/changes/batch-retrieve` with `types: ["PHYSICAL_COUNT"]`.

### Invoice Outstanding
`order.net_amount_due_money` on OPEN orders gives the remaining unpaid balance. OPEN orders are returned when explicitly requesting `state_filter: { states: ["OPEN", "COMPLETED"] }`.

---

## Known Limitations / Future Work

1. **Shrinkage chart is sparse** — only 2 dates of fl oz physical count data (May 15-16). Will populate as staff record weekly counts.
2. **Draft shrinkage** — kegs tracked in whole units, not fl oz. Will pick up automatically if Square inventory switches to fl oz tracking.
3. **Combo detection edge case** — if a combo component's standalone price ever equals the combo price, the detection will miss it. (Current combos all have detectable price deltas.)
4. **Returns in Taproom** — refunds proportionally attributed across categories by order composition. Partial refunds on multi-category orders are approximate.
5. **`combo-sales` API route** — `/api/combo-sales` kept for backwards compatibility, not wired to any UI. Can be removed.
6. **Production module** — `app/production/page.tsx` is a placeholder. Next work: brew batch management, fermentation tracking, production pipelines. Will require a database (Supabase or similar) since this involves mutable structured data beyond Square API reads.
