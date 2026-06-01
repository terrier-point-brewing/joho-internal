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

```
app/
  page.tsx                  — report selector dropdown + renders active report component
  layout.tsx                — html/body shell, metadata
  globals.css               — dark mode base styles (zinc-950 background)
  components/
    ReportControls.tsx      — shared date range + group-by controls + run/export buttons
    CocktailSalesReport.tsx
    KegSalesReport.tsx
    TaproomModelReport.tsx
    GiftCardReport.tsx
    ContractBrewingReport.tsx
    DistributionReport.tsx
    BBLTrackerReport.tsx
    ShrinkageReport.tsx
  api/
    cocktail-sales/route.ts
    keg-sales/route.ts
    taproom-model/route.ts
    gift-cards/route.ts
    contract-brewing/route.ts
    distribution/route.ts
    bbl-tracker/route.ts
    shrinkage/route.ts
    combo-sales/route.ts    — legacy, not used by UI but kept for backwards compat

lib/
  square/
    client.ts               — base fetch wrapper: squareGet, squarePost, squareGetAll, squarePostAll (paginated)
    catalog.ts              — fetchCatalogItems, buildStandalonePriceMap, buildVariationNameMap
    orders.ts               — fetchCompletedOrders (POS, COMPLETED only), fetchInvoiceOrders (OPEN+COMPLETED, Invoice source)
    customers.ts            — fetchCustomers (parallel), customerDisplayName
    refunds.ts              — fetchRefunds
    inventory.ts            — fetchPhysicalCounts (PHYSICAL_COUNT changes, paginated)
  constants/
    categories.ts           — all Square reporting category IDs, TAPROOM_MODEL_CATEGORIES array,
                              CONTRACT_BREWING_SUBCATEGORY_LABELS, classifyContractBrewingItem()
  reports/
    combos.ts               — buildComboIndex, buildComponentIndex, detectComboSales → ComboSale[]
    cocktails.ts            — detectCocktailSales → { sales: CocktailSale[], comboClaimedKeys }
    kegs.ts                 — buildKegIndex, detectKegSales → KegSale[]
    taproom-model.ts        — buildTaproomModelReport → TaproomModelResult
    contract-brewing.ts     — buildContractBrewingReport → { byCategory, byCustomer }
    distribution.ts         — buildDistributionReport → { bySize, byCustomer }
    bbl-tracker.ts          — buildBBLTrackerReport → { byStyle, byChannel, totalExciseTax }
    shrinkage.ts            — buildShrinkageReport → { draft, liquor, chartData }

types/
  square.ts                 — Square API shapes (Order, OrderLineItem, CatalogItem, etc.)
  reports.ts                — ComboSale, CocktailSale, KegSale, TaproomModelResult, etc.
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

Key nuance: the `Keg Transfer (Set 660oz to Draft)` discount flags a keg as an internal draft transfer, not a customer sale. Transfers are shown with amber badge, excluded from money totals.

Group-by: Date / Beer / Beer + Size.

### 3. Taproom (`/api/taproom-model`)
10 categories: Draft Beer, Liquor, Wine/Cider/Seltzers, Cocktails, NA/Snacks, Kegs, Cans, Merchandise, CO2, Other.

Key nuances:
- **Invoice orders are excluded** (`source.name === "Invoices"`) — those are wholesale/contract, not taproom sales.
- **Cocktail combo components** are attributed to the Cocktails category (not Liquor/Draft) using `comboClaimedKeys` from `detectCocktailSales` to prevent double-counting.
- **Keg transfers** excluded from Kegs gross (same detection as Keg Sales report).
- **Gift cards** caught by `item_type === "GIFT_CARD"` (no catalog_object_id) → rolled into Other.
- **Returns** proportionally distributed across categories from the `/v2/refunds` API.
- **Tips** from `order.total_tip_money` — shown as a separate callout below the table.

### 4. Gift Card Sales (`/api/gift-cards`)
Scans all completed orders for `item_type === "GIFT_CARD"` line items. Shows discount reason (e.g., "Employee Draft Discount") in a Discount Notes column. Comped cards (net=$0) are visually dimmed.

### 5. Contract Brewing (`/api/contract-brewing`)
Invoice orders (OPEN + COMPLETED) that contain items in the **Contract Brewing** reporting category (`CDX2UMLF35B4I3F7ILYLMWMF`).

Sub-categories classified by item name via `classifyContractBrewingItem()`:
- **Materials & Packaging**: Ingredient Deposit, Packaging Materials
- **Packaging Fees**: Packaging Fee
- **Pass-Through Taxes**: Barrel Excise Tax (anything with "tax" in name)
- **Other Services**: Keg Cleaning Service, Forklift Fee, everything else

Shows revenue by category (Gross, Net) + Total Discounts callout. By-customer table shows # Invoices, Total Charged, Total Outstanding (`net_amount_due_money`). Outstanding amounts are amber-highlighted.

**Customers in the data:** Argus Beverage Ventures LLC, Local Time Brewing, Fortnight Brewing.

### 6. Distribution (`/api/distribution`)
Invoice orders (OPEN + COMPLETED) that contain items in the **Kegs or Cans** reporting categories. Revenue broken down by keg size (1/2, 1/4, 1/6 Keg, Cans). Customer table includes per-size qty columns. Currently only Fortnight Brewing has distribution invoices.

### 7. BBL Tracker (`/api/bbl-tracker`)
Tracks beer production volume in BBLs by style and distribution channel. Uses both POS orders and invoice orders.

**Channels:**
- `TAPROOM_DRAFT` — keg transfers (Keg Transfer discount on POS orders)
- `TAPROOM_PACKAGED` — taproom keg sales (non-transfer) + can sales
- `DISTRIBUTION` — invoice orders with keg/can items and no contract brewing items
- `CONTRACT_BREWING` — invoice orders with both keg/can items AND contract brewing items

**Volume constants:**
- 1/2 Keg = 15.5 gal, 1/4 Keg = 7.75 gal, 1/6 Keg = 5.167 gal
- Cans: oz parsed from variation name (e.g. "16oz 4-Pack" = 64oz = 0.5 gal)
- 1 BBL = 31 gallons

**Excise tax:** NC state $0.6171/gal + Federal $3.50/BBL

Can sizes: most beers are 16oz cans; BBA/Groundhog Imperial Stouts are 12oz cans. Sold as Regular (single), 4-Pack, or Case (24-pack).

### 8. Shrinkage (`/api/shrinkage`)
Uses Square's `POST /v2/inventory/changes/batch-retrieve` API filtered to `PHYSICAL_COUNT` type (paginated).

**Draft** = items in Draft reporting categories with physical count data.  
**Liquor** = items in Bourbon/Whiskey/Tequila/Rum/Vodka/Gin categories.

Quantities are in fl oz when tracked that way:
- Full 1/6 keg ≈ 660 fl oz
- 750ml spirit bottle = 25.4 fl oz, 1L = 33.8 fl oz

**Shrinkage % per period** = `(prev_count - current_count) / prev_count × 100` for decreases. Increases (restocks) produce `null` (no shrinkage event).

Line chart uses **Recharts** — x=ISO week, y=% depletion per count period. Currently sparse (only May 15-16 counts exist); will populate as weekly counts are recorded.

---

## Square Catalog Category IDs

All IDs are in `lib/constants/categories.ts`.

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

The second ID in each pair is the Holly Springs Taproom sub-location variant.

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

### Inventory Physical Counts
Liquor is tracked in fl oz (decimal quantities like 25.4, 45.4). Draft kegs are currently tracked in whole-unit integer counts — fl oz keg tracking not yet fully deployed. Physical counts are fetched via `POST /v2/inventory/changes/batch-retrieve` with `types: ["PHYSICAL_COUNT"]`.

### Invoice Outstanding
`order.net_amount_due_money` on OPEN orders gives the remaining unpaid balance. OPEN orders are returned by the orders search API when explicitly requested with `state_filter: { states: ["OPEN", "COMPLETED"] }`.

---

## Known Limitations / Future Work

1. **Shrinkage chart is sparse** — only 2 dates of fl oz physical count data (May 15-16). Chart will populate as staff record weekly counts.
2. **Draft shrinkage** — kegs are tracked in whole units, not fl oz. If the taproom starts tracking partial keg volumes in Square inventory, the Shrinkage report's Draft section will pick it up automatically.
3. **Combo detection edge case** — Daisy Pusher Old Fashioned uses Buffalo Trace 2oz ($14 combo vs $13 standalone), correctly detected. If a combo component's standalone price ever equals the combo price, the detection will miss it.
4. **Returns in Taproom** — refunds are proportionally attributed to categories by order line item composition. Partial refunds on multi-category orders are approximate.
5. **`combo-sales` API route** — the old route at `/api/combo-sales` is kept for backwards compatibility but is not wired to any UI. Can be removed.
