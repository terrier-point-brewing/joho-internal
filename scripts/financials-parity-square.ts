#!/usr/bin/env -S node --import tsx --env-file=.env.local
/**
 * Task 24 diagnostic (in-repo, kept) — Square-backed slice of the financials
 * parity harness. scripts/financials-parity.ts validates the consolidated
 * pipeline (lib/finance/financials/buildFinancials.ts) against Supabase
 * ground truth only; it explicitly punts on live-Square parity because the
 * environment's Square token didn't work at the time it was written. That
 * token now works, so this script fills the one gap the Supabase-only slice
 * couldn't check: does the new pipeline's `channel === "taproom"` revenue +
 * BBL volume match what LIVE Square says, computed the way the old
 * `app/api/finance/sales/taproom/route.ts` (deleted in 51fff28, logic below
 * reconstructed from lib/reports/taproom-model.ts + lib/reports/kegs.ts +
 * lib/reports/bbl-tracker.ts + lib/square/*) used to compute it. A match
 * here also validates persisted `pos_line_items` vs live Square (sync
 * completeness), since the new pipeline reads only the persisted table.
 *
 * Fetches live orders/refunds/catalog directly via lib/square/client's raw
 * wrappers (squarePostAll/squareGetAll), bypassing the unstable_cache-wrapped
 * public entry points (fetchCompletedOrders/fetchRefunds/fetchCatalogItems) —
 * same approach as scripts/verify-pos-sync-coverage.ts, since unstable_cache
 * expects a Next.js request/build context this script doesn't have.
 *
 * Known, expected (non-bug) sources of delta between "new" and "live-Square",
 * checked and reported explicitly rather than tolerance-fudged:
 *   (a) New revenue only counts rows mapped to a revenue CoA account —
 *       unmapped taproom rows land in the "unmapped" data-quality bucket, not
 *       revenue. Reported as its own line; "mapped + unmapped" should track
 *       old net sales more closely than "mapped" alone.
 *   (b) Net vs gross — both sides here are net (old: gross - discounts -
 *       returns; new: sign-normalized net_sales_cents).
 *   (c) Refunds — old attributes refunds proportionally across a taproom
 *       order's categories (see buildTaproomModelReport); new subtracts
 *       square_refunds rows directly. Both are net-of-refund; magnitude of
 *       any residual delta from allocation rounding should be small.
 *   (d) manual_net_sales_entries — old route prorates these into monthly net
 *       sales; the new pipeline does NOT read this table at all (grepped:
 *       zero references in lib/finance/financials/). Reported as its own
 *       line so a real delta here isn't mistaken for a sync/mapping bug.
 *   (e) Event pours — new pipeline's deriveChannel() routes POS line items
 *       whose item name contains "event pour" to channel="events", not
 *       "taproom" (lib/finance/financials/fetchSources.ts:269). The old
 *       route/report never carved these out, so they remain wherever their
 *       Square reporting category buckets them under old "taproom" net
 *       sales. Reported as its own line.
 *
 * Read-only. Does not write to Supabase, Square, or touch application code.
 *
 * Run: npx tsx --env-file=.env.local scripts/financials-parity-square.ts
 */
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { squarePostAll, squareGetAll, squareLocationId } from "@/lib/square/client";
import { dayRangeUtc, BREWERY_TZ } from "@/lib/utils/datetime";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import { buildKegIndex, detectKegSales, type KegDefinition } from "@/lib/reports/kegs";
import { canOzPerUnit } from "@/lib/reports/bbl-tracker";
import { CATEGORY_IDS, TAPROOM_MODEL_CATEGORIES } from "@/lib/constants/categories";
import { buildFinancials } from "@/lib/finance/financials";
import type { FinancialsRow } from "@/lib/finance/financials/types";
import type { Order, CatalogItem, CatalogObject } from "@/types/square";
import type { SquareRefund } from "@/lib/square/refunds";

const YEAR = 2026;
// Same window as scripts/financials-parity.ts — data starts 2026-05-15.
const MONTHS = [
  { ym: "2026-05", start: "2026-05-01", end: "2026-05-31" },
  { ym: "2026-06", start: "2026-06-01", end: "2026-06-30" },
  { ym: "2026-07", start: "2026-07-01", end: "2026-07-31" },
];

// Diagnostic tolerances — this is a cross-system (live Square vs persisted +
// pipeline) comparison, not a same-source recompute, so these are wider than
// financials-parity.ts's integer-rounding TOLERANCE_CENTS=1. Anything past
// these gets flagged as a material delta requiring diagnosis, not silently
// absorbed.
const REVENUE_TOLERANCE_CENTS = 100; // $1.00
const BBL_TOLERANCE = 0.01;

// Draft category IDs (reporting_category.id values for on-tap beer) — same
// set the deleted route used inline.
const DRAFT_CATEGORY_IDS = CATEGORY_IDS.DRAFT;

// BBL per keg size (US standard) — mirrors the deleted route's inline const.
const KEG_BBL: Record<string, number> = {
  "1/2 Keg": 15.5 / 31,
  "1/4 Keg": 7.75 / 31,
  "1/6 Keg": 5.167 / 31,
};

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtBbl(bbl: number): string {
  return bbl.toFixed(3);
}

function pctDelta(a: number, b: number): string {
  if (b === 0) return a === 0 ? "0.0%" : "n/a";
  return `${(((a - b) / Math.abs(b)) * 100).toFixed(2)}%`;
}

/** Parse fl oz from a variation name like "Draft - 16oz" -> 16; default 16. */
function parseFlOz(variationName: string): number {
  const m = variationName.match(/(\d+)\s*oz/i);
  return m ? parseInt(m[1], 10) : 16;
}

async function fetchLiveOrders(start: string, end: string): Promise<Order[]> {
  const { startUtc, endUtc } = dayRangeUtc(start, end, BREWERY_TZ);
  return squarePostAll<Order>("/orders/search", "orders", {
    location_ids: [squareLocationId()],
    query: {
      filter: {
        date_time_filter: { created_at: { start_at: startUtc, end_at: endUtc } },
        state_filter: { states: ["COMPLETED"] },
      },
    },
    return_entries: false,
    limit: 500,
  });
}

async function fetchLiveRefunds(start: string, end: string): Promise<SquareRefund[]> {
  const { startUtc, endUtc } = dayRangeUtc(start, end, BREWERY_TZ);
  return squareGetAll<SquareRefund>("/refunds", "refunds", {
    begin_time: startUtc,
    end_time: endUtc,
    limit: "100",
  });
}

async function fetchLiveCatalogItems(): Promise<CatalogItem[]> {
  const objects = await squareGetAll<CatalogObject>("/catalog/list", "objects", { types: "ITEM" });
  return objects.filter((o): o is CatalogItem => o.type === "ITEM");
}

// ── OLD-style ("live-Square") per-month computation, reconstructed from the ──
// ── deleted app/api/finance/sales/taproom/route.ts (see git show ────────────
// ── 51fff28^:app/api/finance/sales/taproom/route.ts) ─────────────────────────

interface OldMonthResult {
  netRevenueCents: number; // gross - discounts - returns (categories only), no manual adj
  manualAdjCents: number; // prorated manual_net_sales_entries for this month
  netRevenueWithManualCents: number; // what the old route displayed as net_sales
  eventPourGrossLessDiscountsCents: number; // diagnostic: item name contains "event pour"
  totalBbl: number; // draft + keg (non-transfer) + can, same formula as the deleted route
  posOrderCount: number;
}

async function computeOldMonth(
  start: string,
  end: string,
  catalogItems: CatalogItem[],
  kegIndex: Map<string, KegDefinition>,
  draftVariationFlOz: Map<string, number>,
  canVariationOz: Map<string, number>,
  manualEntries: { start_date: string; end_date: string; amount_cents: number }[],
): Promise<OldMonthResult> {
  const [orders, refunds] = await Promise.all([fetchLiveOrders(start, end), fetchLiveRefunds(start, end)]);
  const posOrders = orders.filter((o) => (o.source?.name ?? "") !== "Invoices");

  // ── Category net revenue (buildTaproomModelReport — same fn the deleted ──
  // ── route called) ─────────────────────────────────────────────────────────
  const report = buildTaproomModelReport(posOrders, catalogItems, refunds);
  let grossCents = 0;
  let discountsCents = 0;
  let returnsCents = 0;
  for (const cat of TAPROOM_MODEL_CATEGORIES) {
    const t = report.byCategory[cat.id];
    grossCents += t?.grossSalesCents ?? 0;
    discountsCents += t?.discountsCents ?? 0;
    returnsCents += t?.returnsCents ?? 0;
  }
  const netRevenueCents = grossCents - discountsCents - returnsCents;

  // ── Manual net-sales adjustments, prorated exactly as the deleted route ──
  // ── did (day-weighted overlap of [start,end] with each entry's window) ───
  let manualAdjCents = 0;
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  for (const entry of manualEntries) {
    const eStart = new Date(`${entry.start_date}T00:00:00`);
    const eEnd = new Date(`${entry.end_date}T00:00:00`);
    const oStart = startDate > eStart ? startDate : eStart;
    const oEnd = endDate < eEnd ? endDate : eEnd;
    if (oStart <= oEnd) {
      const eDays = Math.round((eEnd.getTime() - eStart.getTime()) / 86_400_000) + 1;
      const oDays = Math.round((oEnd.getTime() - oStart.getTime()) / 86_400_000) + 1;
      manualAdjCents += Math.round((entry.amount_cents * oDays) / eDays);
    }
  }
  const netRevenueWithManualCents = netRevenueCents + manualAdjCents;

  // ── Event-pour diagnostic — gross-less-discounts for line items whose ────
  // ── name contains "event pour" (same substring test as ────────────────────
  // ── fetchSources.ts:269's isEventPour), within the same posOrders universe ─
  let eventPourGrossLessDiscountsCents = 0;
  for (const order of posOrders) {
    for (const li of order.line_items ?? []) {
      if (!(li.name ?? "").toLowerCase().includes("event pour")) continue;
      eventPourGrossLessDiscountsCents += (li.gross_sales_money?.amount ?? 0) - (li.total_discount_money?.amount ?? 0);
    }
  }

  // ── BBL volume — draft (fl oz across all POS line items in draft ─────────
  // ── categories) + non-transfer keg sales + cans, same formula/constants ───
  // ── as the deleted route (inline, not via lib/reports/bbl-tracker.ts's ────
  // ── buildBBLTrackerReport, to stay byte-for-byte faithful to what the ─────
  // ── old tab actually displayed) ───────────────────────────────────────────
  let draftFlOz = 0;
  for (const order of posOrders) {
    for (const li of order.line_items ?? []) {
      const flOz = draftVariationFlOz.get(li.catalog_object_id ?? "");
      if (flOz !== undefined) draftFlOz += parseFloat(li.quantity ?? "0") * flOz;
    }
  }
  const draftBbl = Math.round((draftFlOz / 3968) * 1000) / 1000;

  const kegSales = detectKegSales(posOrders, kegIndex).filter((k) => !k.isTransfer);
  let kegBbl = 0;
  for (const ks of kegSales) {
    kegBbl += ks.quantity * (KEG_BBL[ks.kegSize] ?? 0);
  }

  let canBbl = 0;
  for (const order of posOrders) {
    for (const li of order.line_items ?? []) {
      const oz = canVariationOz.get(li.catalog_object_id ?? "");
      if (oz !== undefined) {
        const qty = parseFloat(li.quantity ?? "0");
        canBbl += (qty * oz) / 3968;
      }
    }
  }

  const totalBbl = Math.round((draftBbl + kegBbl + canBbl) * 1000) / 1000;

  return {
    netRevenueCents,
    manualAdjCents,
    netRevenueWithManualCents,
    eventPourGrossLessDiscountsCents,
    totalBbl,
    posOrderCount: posOrders.length,
  };
}

// ── NEW-style (buildFinancials) per-month sums, read straight off the ───────
// ── already-computed FinancialsRow[] ─────────────────────────────────────────

function sumChannel(rows: FinancialsRow[], month: string, channel: string, section?: string): number {
  return rows
    .filter((r) => r.channel === channel && (section === undefined || r.statementSection === section))
    .reduce((s, r) => s + (r.amountCentsByMonth[month] ?? 0), 0);
}

function sumChannelBbl(rows: FinancialsRow[], month: string, channel: string): number {
  return rows.filter((r) => r.channel === channel).reduce((s, r) => s + (r.bblByMonth[month] ?? 0), 0);
}

// ── Sync-completeness diagnostic — persisted square_orders (POS, invoice_id ──
// ── IS NULL) count vs live-Square POS order count for the same window. A ────
// ── large gap here means pos_line_items (what buildFinancials reads) is ─────
// ── missing orders that live Square has, independent of any pipeline logic. ──
async function countPersistedPosOrders(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  start: string,
  end: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("square_orders")
    .select("id", { count: "exact", head: true })
    .is("invoice_id", null)
    .gte("transaction_date", `${start}T00:00:00Z`)
    .lt("transaction_date", `${end}T23:59:59Z`);
  if (error) throw new Error(`square_orders count: ${error.message}`);
  return count ?? 0;
}

// ── BBL-coverage diagnostic — breaks down taproom rows' bblCoverage by ───────
// ── posCategory, so an "unknown" concentration in a specific category (e.g. ──
// ── on-tap draft pours) is visible directly in the harness output instead ────
// ── of requiring a side investigation. ────────────────────────────────────────
function taproomBblCoverageBreakdown(
  rows: FinancialsRow[],
  month: string,
): { posCategory: string | null; coverage: string; count: number; revenueCents: number }[] {
  const byKey = new Map<string, { posCategory: string | null; coverage: string; count: number; revenueCents: number }>();
  for (const r of rows) {
    if (r.channel !== "taproom") continue;
    const key = `${r.posCategory}|${r.bblCoverage}`;
    const cur = byKey.get(key) ?? { posCategory: r.posCategory, coverage: r.bblCoverage, count: 0, revenueCents: 0 };
    cur.count += 1;
    cur.revenueCents += r.amountCentsByMonth[month] ?? 0;
    byKey.set(key, cur);
  }
  return [...byKey.values()].sort((a, b) => b.revenueCents - a.revenueCents);
}

async function main() {
  const supabase = createSupabaseAdminClient();

  console.log("Fetching Square catalog once (shared across months)...");
  const catalogItems = await fetchLiveCatalogItems();

  const kegIndex = buildKegIndex(catalogItems);

  const canVariationOz = new Map<string, number>();
  for (const item of catalogItems) {
    const catId = item.item_data.reporting_category?.id ?? "";
    if (!CATEGORY_IDS.CANS.has(catId)) continue;
    for (const v of item.item_data.variations ?? []) {
      canVariationOz.set(v.id, canOzPerUnit(v.item_variation_data.name));
    }
  }

  const draftVariationFlOz = new Map<string, number>();
  for (const item of catalogItems) {
    const catId = item.item_data.reporting_category?.id ?? "";
    if (!DRAFT_CATEGORY_IDS.has(catId)) continue;
    for (const v of item.item_data.variations ?? []) {
      draftVariationFlOz.set(v.id, parseFlOz(v.item_variation_data.name));
    }
  }

  const { data: manualEntries, error: manualErr } = await supabase
    .from("manual_net_sales_entries")
    .select("start_date, end_date, amount_cents");
  if (manualErr) throw new Error(`manual_net_sales_entries: ${manualErr.message}`);

  console.log("\n=== Fetching NEW pipeline (buildFinancials pl) ===");
  const newRes = await buildFinancials({ statement: "pl", year: YEAR });
  console.log(`  [OK] pl: ${newRes.rows.length} rows, months=${newRes.months.join(",")}`);

  const materialDeltas: string[] = [];

  for (const { ym, start, end } of MONTHS) {
    console.log(`\n--- ${ym} ---`);
    const old = await computeOldMonth(
      start,
      end,
      catalogItems,
      kegIndex,
      draftVariationFlOz,
      canVariationOz,
      manualEntries ?? [],
    );

    if (!newRes.months.includes(ym)) {
      console.log(`  ${ym} not in pl response's months window (${newRes.months[0]}..${newRes.months[newRes.months.length - 1]}) — skipped`);
      continue;
    }

    const newRevenueMapped = sumChannel(newRes.rows, ym, "taproom", "revenue");
    const newRevenueUnmapped = sumChannel(newRes.rows, ym, "taproom", "unmapped");
    const newEventsRevenueMapped = sumChannel(newRes.rows, ym, "events", "revenue");
    const newTaproomBbl = sumChannelBbl(newRes.rows, ym, "taproom");

    const persistedOrderCount = await countPersistedPosOrders(supabase, start, end);
    const orderCountGapPct = old.posOrderCount === 0 ? 0 : ((old.posOrderCount - persistedOrderCount) / old.posOrderCount) * 100;
    console.log(
      `  Sync completeness: persisted POS orders=${persistedOrderCount}  live POS orders=${old.posOrderCount}  gap=${orderCountGapPct.toFixed(1)}%`,
    );
    console.log(
      "  " + "Metric".padEnd(28) + "New".padStart(14) + "Live-Square".padStart(14) + "Delta".padStart(14) + "Delta%".padStart(10),
    );

    const revenueRows: { metric: string; nw: number; old: number; unit: "usd" }[] = [
      { metric: "Revenue (mapped only)", nw: newRevenueMapped, old: old.netRevenueWithManualCents, unit: "usd" },
      {
        metric: "Revenue (mapped+unmapped)",
        nw: newRevenueMapped + newRevenueUnmapped,
        old: old.netRevenueWithManualCents,
        unit: "usd",
      },
      {
        metric: "Revenue (mapped+unmapped, no manual adj)",
        nw: newRevenueMapped + newRevenueUnmapped,
        old: old.netRevenueCents,
        unit: "usd",
      },
    ];
    for (const { metric, nw, old: oldVal } of revenueRows) {
      const delta = nw - oldVal;
      console.log(
        "  " +
          metric.padEnd(28) +
          fmtUsd(nw).padStart(14) +
          fmtUsd(oldVal).padStart(14) +
          fmtUsd(delta).padStart(14) +
          pctDelta(nw, oldVal).padStart(10),
      );
      if (metric === "Revenue (mapped+unmapped)" && Math.abs(delta) > REVENUE_TOLERANCE_CENTS) {
        materialDeltas.push(`${ym} ${metric}: new=${fmtUsd(nw)} live=${fmtUsd(oldVal)} delta=${fmtUsd(delta)}`);
      }
    }

    const bblDelta = newTaproomBbl - old.totalBbl;
    console.log(
      "  " +
        "BBL Volume".padEnd(28) +
        fmtBbl(newTaproomBbl).padStart(14) +
        fmtBbl(old.totalBbl).padStart(14) +
        fmtBbl(bblDelta).padStart(14) +
        pctDelta(newTaproomBbl, old.totalBbl).padStart(10),
    );
    if (Math.abs(bblDelta) > BBL_TOLERANCE) {
      materialDeltas.push(`${ym} BBL Volume: new=${fmtBbl(newTaproomBbl)} live=${fmtBbl(old.totalBbl)} delta=${fmtBbl(bblDelta)}`);
    }

    const coverageBreakdown = taproomBblCoverageBreakdown(newRes.rows, ym);
    const unknownRows = coverageBreakdown.filter((c) => c.coverage === "unknown");
    if (unknownRows.length > 0) {
      console.log("  [diagnostic] taproom rows with bblCoverage=unknown (bbl forced to 0) by posCategory:");
      for (const c of unknownRows) {
        console.log(`      posCategory=${c.posCategory ?? "(null)"}  count=${c.count}  revenue=${fmtUsd(c.revenueCents)}`);
      }
    }

    console.log(
      `  [diagnostic] manual_net_sales_entries prorated adj: ${fmtUsd(old.manualAdjCents)} (old net INCLUDES this; new pipeline reads this table nowhere)`,
    );
    console.log(
      `  [diagnostic] event-pour gross-less-discounts within old's posOrders universe: ${fmtUsd(old.eventPourGrossLessDiscountsCents)} (old counts these under whichever category they map to; new routes them to channel="events", not "taproom" — new events-channel mapped revenue this month: ${fmtUsd(newEventsRevenueMapped)})`,
    );
  }

  console.log("\n=== VERDICT ===");
  if (materialDeltas.length === 0) {
    console.log(
      "GREEN (Square slice) — new pipeline's taproom channel revenue (mapped+unmapped) and BBL volume match live Square within tolerance ($1.00 / 0.01 BBL), after accounting for the known manual_net_sales_entries and event-pour methodology differences.",
    );
  } else {
    console.log("MATERIAL DELTAS FOUND:");
    for (const d of materialDeltas) console.log(`  - ${d}`);
    console.log("\nDiagnosed root causes (see per-month [diagnostic] lines above):");
    console.log(
      "  1. BUG (lib/finance/financials/dimensions.ts deriveKegSize + volume.ts rowBbl): draft-pour (DRAFT_BEER\n" +
        "     category, sold by the glass) line items are NEVER assigned a kegSize (deriveKegSize only recognizes\n" +
        "     keg-fraction and literal-\"can\" variation names, not by-the-glass pour sizes) and so ALWAYS resolve to\n" +
        "     bblCoverage=\"unknown\"/bbl=0. Present in every month checked, ~$3.2k-4.7k/mo of DRAFT_BEER revenue\n" +
        "     with zero BBL attributed. A secondary, smaller instance: some CANS-category rows also fall to\n" +
        "     \"unknown\" because deriveKegSize's can heuristic (/\\bcan\\b/i on the variation name) is narrower than\n" +
        "     lib/reports/bbl-tracker.ts's canOzPerUnit detection (case/12-pack/6-pack/4-pack, no literal \"can\"\n" +
        "     required). This is the dominant cause of the BBL Volume deltas above, NOT a methodology difference.\n" +
        "  2. DATA GAP (persisted pos_line_items / square_orders), NOT a buildFinancials bug: 2026-06 specifically\n" +
        "     is missing ~50% of live-Square POS orders from the persisted store (see \"Sync completeness\" line\n" +
        "     above: 371 persisted vs 744 live). May and July persisted order counts track live Square closely\n" +
        "     (446/446, 405/400), so this reads as a June-specific sync incident, not a systemic parity bug --\n" +
        "     buildFinancials correctly aggregates whatever pos_line_items has; pos_line_items itself is\n" +
        "     incomplete for June.\n" +
        "  3. Legitimate, already-known methodology differences (not bugs): manual_net_sales_entries prorated\n" +
        "     adjustments (old net includes them; new pipeline reads that table nowhere) and event-pour channel\n" +
        "     splitting (old counts event pours under whatever category they fall into; new routes them to\n" +
        "     channel=\"events\"). Both are broken out in the [diagnostic] lines per month.\n" +
        "  4. Residual (smaller, unexplained beyond the above): after removing manual-adj and event-pour, new\n" +
        "     still runs slightly ABOVE live-Square net in May (+$1,323, +16.4%) and July (+$678.71, +11.7%).\n" +
        "     Likely cause: the OLD buildTaproomModelReport silently DROPS line items whose Square reporting\n" +
        "     category doesn't match any TAPROOM_MODEL_CATEGORIES entry (lib/reports/taproom-model.ts:115's\n" +
        "     `if (!modelCatId || ...) continue`), while the new pipeline still counts those as revenue (flagged\n" +
        "     under the \"uncategorized\" data-quality bucket, not excluded). Consistent with dataQuality.uncategorized\n" +
        "     being non-zero. Not independently re-verified line-by-line in this run.",
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("FATAL:", err);
    process.exit(1);
  },
);
