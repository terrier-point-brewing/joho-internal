#!/usr/bin/env -S node --import tsx --env-file=.env.local
/**
 * Task 0 diagnostic (throwaway) — verifies persisted `pos_line_items` is
 * complete enough to replace the live-Square taproom read path.
 *
 * For each sample month, computes:
 *   - persistedGrossCents:  SUM(pos_line_items.gross_sales_cents) for POS
 *                            orders (square_orders.invoice_id IS NULL) whose
 *                            transaction_date falls in the month.
 *   - liveRawGrossCents:    SUM of gross_sales_money across ALL line items of
 *                            live-Square POS orders (source.name !=
 *                            "Invoices", state COMPLETED) for the same month —
 *                            same universe as the persisted number (no
 *                            category filtering), so this isolates pure sync
 *                            coverage.
 *   - liveModelGrossCents:  what app/api/finance/sales/taproom/route.ts
 *                            actually displays today — gross summed only
 *                            across TAPROOM_MODEL_CATEGORIES via
 *                            buildTaproomModelReport (cocktails/kegs/refund
 *                            logic + catalog-category bucketing). Included
 *                            for context: even a fully-synced persisted table
 *                            won't match this number unless the repoint also
 *                            ports the category-bucketing logic.
 *
 * Read-only. Does not write to Supabase, Square, or touch application code.
 *
 * Run: npx tsx --env-file=.env.local scripts/verify-pos-sync-coverage.ts
 */
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { squarePostAll, squareGetAll, squareLocationId } from "@/lib/square/client";
import { dayRangeUtc, BREWERY_TZ } from "@/lib/utils/datetime";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import type { Order, CatalogItem, CatalogObject } from "@/types/square";
import type { SquareRefund } from "@/lib/square/refunds";

// ── Sample months: 3 most recent CLOSED months relative to today (2026-07-11) ──
const MONTHS = [
  { label: "2026-04", start: "2026-04-01", end: "2026-04-30" },
  { label: "2026-05", start: "2026-05-01", end: "2026-05-31" },
  { label: "2026-06", start: "2026-06-01", end: "2026-06-30" },
];

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

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

async function main() {
  const supabase = createSupabaseAdminClient();

  console.log("Fetching Square catalog once (shared across months)...");
  const catalogItems = await fetchLiveCatalogItems();

  const rows: {
    label: string;
    persistedGrossCents: number;
    persistedOrderCount: number;
    liveRawGrossCents: number;
    liveOrderCount: number;
    liveModelGrossCents: number;
  }[] = [];

  for (const { label, start, end } of MONTHS) {
    console.log(`\n--- ${label} ---`);

    // ── Persisted side: pos_line_items joined to square_orders, invoice_id IS NULL ──
    const endExclusive = `${end}T23:59:59.999`;
    const { data: posOrders, error: ordersErr } = await supabase
      .from("square_orders")
      .select("id")
      .is("invoice_id", null)
      .gte("transaction_date", `${start}T00:00:00`)
      .lte("transaction_date", endExclusive);
    if (ordersErr) throw new Error(`square_orders query failed: ${ordersErr.message}`);

    const orderIds = (posOrders ?? []).map((o) => o.id);
    let persistedGrossCents = 0;
    const CHUNK = 500;
    for (let i = 0; i < orderIds.length; i += CHUNK) {
      const chunk = orderIds.slice(i, i + CHUNK);
      if (chunk.length === 0) continue;
      const { data: lines, error: linesErr } = await supabase
        .from("pos_line_items")
        .select("gross_sales_cents")
        .in("order_id", chunk);
      if (linesErr) throw new Error(`pos_line_items query failed: ${linesErr.message}`);
      for (const l of lines ?? []) persistedGrossCents += l.gross_sales_cents ?? 0;
    }

    // ── Live-Square control ──
    const [liveOrders, refunds] = await Promise.all([
      fetchLiveOrders(start, end),
      fetchLiveRefunds(start, end),
    ]);
    const posLiveOrders = liveOrders.filter((o) => (o.source?.name ?? "") !== "Invoices");

    let liveRawGrossCents = 0;
    for (const order of posLiveOrders) {
      for (const li of order.line_items ?? []) {
        liveRawGrossCents += li.gross_sales_money?.amount ?? 0;
      }
    }

    const modelReport = buildTaproomModelReport(posLiveOrders, catalogItems, refunds);
    const liveModelGrossCents = Object.values(modelReport.byCategory).reduce(
      (s, t) => s + t.grossSalesCents,
      0,
    );

    rows.push({
      label,
      persistedGrossCents,
      persistedOrderCount: orderIds.length,
      liveRawGrossCents,
      liveOrderCount: posLiveOrders.length,
      liveModelGrossCents,
    });

    console.log(`  Persisted (pos_line_items, invoice_id IS NULL): ${fmtUsd(persistedGrossCents)}  (${orderIds.length} orders)`);
    console.log(`  Live raw (all POS line items, no category filter): ${fmtUsd(liveRawGrossCents)}  (${posLiveOrders.length} orders)`);
    console.log(`  Live route-model (TAPROOM_MODEL_CATEGORIES only, current route's number): ${fmtUsd(liveModelGrossCents)}`);
  }

  // ── Summary table ──
  console.log("\n\n=== SUMMARY: persisted vs live-raw (sync coverage) ===");
  console.log(
    "Month".padEnd(10) +
      "Persisted".padStart(14) +
      "Live Raw".padStart(14) +
      "Delta".padStart(14) +
      "Delta %".padStart(10) +
      "  Orders (P/L)",
  );
  for (const r of rows) {
    const delta = r.liveRawGrossCents - r.persistedGrossCents;
    const deltaPct = r.liveRawGrossCents === 0 ? 0 : (delta / r.liveRawGrossCents) * 100;
    console.log(
      r.label.padEnd(10) +
        fmtUsd(r.persistedGrossCents).padStart(14) +
        fmtUsd(r.liveRawGrossCents).padStart(14) +
        fmtUsd(delta).padStart(14) +
        `${deltaPct.toFixed(1)}%`.padStart(10) +
        `  ${r.persistedOrderCount}/${r.liveOrderCount}`,
    );
  }

  console.log("\n=== SUMMARY: live-raw vs live-route-model (category definition delta) ===");
  console.log("Month".padEnd(10) + "Live Raw".padStart(14) + "Live Model".padStart(14) + "Delta".padStart(14));
  for (const r of rows) {
    const delta = r.liveRawGrossCents - r.liveModelGrossCents;
    console.log(
      r.label.padEnd(10) +
        fmtUsd(r.liveRawGrossCents).padStart(14) +
        fmtUsd(r.liveModelGrossCents).padStart(14) +
        fmtUsd(delta).padStart(14),
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
