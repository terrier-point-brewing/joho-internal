// Keeping what the forecast said, so it can be checked once the month has
// happened. See supabase/migrations/20261225090000_forecast_snapshots.sql.
//
// The snapshot is always the BASE case and is always computed here, on the
// server, from the same statement builder and the same pure forecast the page
// uses — never posted up from a browser, whose levers describe a scenario
// rather than a prediction.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildFinancials } from "@/lib/finance/financials/buildFinancials";
import { computeCashOnHandCents } from "@/lib/finance/balances/cashRunway";
import { todayLocalDate } from "@/lib/utils/datetime";
import { fetchForecastDrivers } from "./drivers.server";
import { buildForecast } from "./forecast";
import { addMonths } from "./drawdown";
import { BASE_ASSUMPTIONS, type ForecastSnapshot } from "./types";

/** How far ahead each snapshot looks, so a month can later be judged at several distances. */
const SNAPSHOT_HORIZON = 6 as const;
/** How many months of snapshots the accuracy panel is given. */
const HISTORY_MONTHS = 18;

const STATEMENTS = ["pl", "cash_flow"] as const;

/**
 * Saves the base-case forecast as it stands today, replacing whatever this
 * month already saved. Safe to run any number of times: it only ever writes
 * rows made in the open month, and a month that has ended is never touched.
 */
export async function saveForecastSnapshots(supabase: SupabaseClient): Promise<{ madeMonth: string; saved: number }> {
  const today = todayLocalDate();
  const madeMonth = today.slice(0, 7);
  const cashOnHand = await computeCashOnHandCents(supabase, today).catch(() => null);
  const drivers = await fetchForecastDrivers(supabase, today, cashOnHand);

  const rows: Record<string, unknown>[] = [];
  for (const statement of STATEMENTS) {
    const data = await buildFinancials({ statement, year: Number(today.slice(0, 4)) });
    const result = buildForecast({
      rows: data.rows,
      months: data.months,
      coaAccounts: data.coaAccounts,
      statement,
      drivers,
      assumptions: { ...BASE_ASSUMPTIONS, horizonMonths: SNAPSHOT_HORIZON },
    });
    if (!result) continue;
    for (const target of result.forecastMonths) {
      rows.push({
        made_month: madeMonth,
        target_month: target,
        statement,
        revenue_cents: result.revenueCentsByMonth[target] ?? 0,
        net_cents: result.netCentsByMonth[target] ?? 0,
        shipped_bbl: Math.round((result.shippedBblByMonth[target] ?? 0) * 100) / 100,
        made_on: today,
      });
    }
  }

  if (rows.length > 0) {
    const { error } = await supabase.from("forecast_snapshots").upsert(rows, { onConflict: "made_month,target_month,statement" });
    if (error) throw new Error(`forecast snapshot save failed: ${error.message}`);
  }
  return { madeMonth, saved: rows.length };
}

interface SnapshotRow {
  made_month: string;
  target_month: string;
  statement: "pl" | "cash_flow";
  revenue_cents: number | string;
  net_cents: number | string;
  shipped_bbl: number | string;
  made_on: string;
}

export async function listForecastSnapshots(supabase: SupabaseClient): Promise<ForecastSnapshot[]> {
  const since = addMonths(todayLocalDate().slice(0, 7), -HISTORY_MONTHS);
  const { data, error } = await supabase
    .from("forecast_snapshots")
    .select("made_month, target_month, statement, revenue_cents, net_cents, shipped_bbl, made_on")
    .gte("made_month", since)
    .order("made_month")
    .order("target_month");
  if (error) throw new Error(`forecast snapshot read failed: ${error.message}`);
  return ((data ?? []) as SnapshotRow[]).map((r) => ({
    madeMonth: r.made_month,
    targetMonth: r.target_month,
    statement: r.statement,
    revenueCents: Number(r.revenue_cents),
    netCents: Number(r.net_cents),
    shippedBbl: Number(r.shipped_bbl),
    madeOn: r.made_on,
  }));
}
