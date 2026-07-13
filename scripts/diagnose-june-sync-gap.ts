#!/usr/bin/env -S node --import tsx --env-file=.env.local
/**
 * Throwaway diagnostic — enumerate which June-2026 live-Square POS orders are
 * missing from persisted `square_orders`/`pos_line_items`, and characterize the
 * missing set (by created day, closed day, state) to reveal the outage shape.
 *
 * Keys the persisted-vs-live diff by square_order_id (not transaction_date) so a
 * created_at/closed_at boundary shift can't masquerade as "missing".
 *
 * Read-only. Run: npx tsx --env-file=.env.local scripts/diagnose-june-sync-gap.ts
 */
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { squarePostAll, squareLocationId } from "@/lib/square/client";
import { dayRangeUtc, BREWERY_TZ } from "@/lib/utils/datetime";
import type { Order } from "@/types/square";

const START = "2026-06-01";
const END = "2026-06-30";

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

function dayKey(iso: string | undefined): string {
  if (!iso) return "(none)";
  // Convert to brewery-local day.
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: BREWERY_TZ });
}

async function main() {
  const supabase = createSupabaseAdminClient();

  console.log(`Fetching live Square COMPLETED orders created in ${START}..${END} ...`);
  const liveOrders = await fetchLiveOrders(START, END);
  const posLive = liveOrders.filter((o) => (o.source?.name ?? "") !== "Invoices");
  console.log(`  live total=${liveOrders.length}  POS (source!=Invoices)=${posLive.length}`);

  // Persisted: query square_orders for exactly the live POS order ids.
  const liveIds = posLive.map((o) => o.id);
  const persistedIds = new Set<string>();
  const CHUNK = 300;
  for (let i = 0; i < liveIds.length; i += CHUNK) {
    const chunk = liveIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("square_orders")
      .select("square_order_id, invoice_id, transaction_date")
      .in("square_order_id", chunk);
    if (error) throw new Error(`square_orders lookup: ${error.message}`);
    for (const r of data ?? []) persistedIds.add(r.square_order_id);
  }

  const missing = posLive.filter((o) => !persistedIds.has(o.id));
  console.log(`\nPersisted (by id, any transaction_date): ${persistedIds.size}/${posLive.length}`);
  console.log(`MISSING from square_orders: ${missing.length}`);

  // Characterize missing by created day and closed day.
  const byCreatedDay = new Map<string, number>();
  const byClosedDay = new Map<string, number>();
  const byState = new Map<string, number>();
  let missingRevenueCents = 0;
  for (const o of missing) {
    byCreatedDay.set(dayKey(o.created_at), (byCreatedDay.get(dayKey(o.created_at)) ?? 0) + 1);
    byClosedDay.set(dayKey(o.closed_at), (byClosedDay.get(dayKey(o.closed_at)) ?? 0) + 1);
    byState.set(o.state ?? "(none)", (byState.get(o.state ?? "(none)") ?? 0) + 1);
    missingRevenueCents += o.total_money?.amount ?? 0;
  }

  // Also compute present-by-created-day so we can see the ratio per day.
  const presentByCreatedDay = new Map<string, number>();
  for (const o of posLive) {
    if (persistedIds.has(o.id)) {
      presentByCreatedDay.set(dayKey(o.created_at), (presentByCreatedDay.get(dayKey(o.created_at)) ?? 0) + 1);
    }
  }

  console.log(`\nMissing revenue (total_money): $${(missingRevenueCents / 100).toFixed(2)}`);
  console.log(`Missing by state: ${[...byState.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);

  console.log(`\nPer-day breakdown (created_at, brewery-local) — present / missing / total:`);
  const allDays = new Set([...byCreatedDay.keys(), ...presentByCreatedDay.keys()]);
  const sortedDays = [...allDays].sort();
  for (const d of sortedDays) {
    const miss = byCreatedDay.get(d) ?? 0;
    const pres = presentByCreatedDay.get(d) ?? 0;
    const tot = miss + pres;
    const bar = miss === 0 ? "" : "  <-- missing";
    console.log(`  ${d}:  present=${String(pres).padStart(3)}  missing=${String(miss).padStart(3)}  total=${String(tot).padStart(3)}${bar}`);
  }

  // Sample a few missing order ids + timestamps for spot-checking.
  console.log(`\nSample missing orders (first 10):`);
  for (const o of missing.slice(0, 10)) {
    console.log(`  ${o.id}  created=${o.created_at}  closed=${o.closed_at ?? "(none)"}  state=${o.state}  total=$${((o.total_money?.amount ?? 0) / 100).toFixed(2)}  source=${o.source?.name ?? "(none)"}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("FATAL:", err);
    process.exit(1);
  },
);
