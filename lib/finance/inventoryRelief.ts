/**
 * Inventory relief — the P&L half of the inventory the balance sheet already
 * carries.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * Every ingredient and packaging purchase is expensed straight to the P&L the
 * day it is coded, while the balance sheet values what is ON THE SHELF through
 * the "Inventory on hand" method. The asset got recorded; equity never got the
 * credit — which is precisely the balancing difference the statement showed
 * ($26,803.76 of it, measured 2026-08-30).
 *
 * The standard periodic-method answer: cost of goods sold for a month is
 * purchases MINUS the change in inventory. Purchases keep coding exactly where
 * they always have; this module derives one relief row per month per inventory
 * account — the month's CHANGE in that account's value — and the P&L posts it
 * against the COGS account the operator names in the method's setup. Inventory
 * up → purchases weren't all consumed → cost comes down. Inventory down → the
 * kitchen ate the shelf → cost goes up. Nothing is written anywhere; the rows
 * are computed, the same way retained earnings and depreciation are.
 *
 * ── Where the monthly values come from ───────────────────────────────────────
 * The SAME figures the balance sheet shows: gl_account_balances snapshots for
 * every stored month, and the live valuation for the current month. Deriving
 * the P&L side from the balance-sheet side is what guarantees the two
 * statements tie — cumulative relief through any month IS that month's
 * inventory value, to the cent.
 *
 * A month with no stored value carries the last known one forward (Δ 0), and
 * the first month a value EXISTS relieves the whole of it — the correct
 * one-time catch-up for a business that expensed every purchase until
 * inventory tracking began.
 *
 * ── The one approximation, stated ────────────────────────────────────────────
 * The current month's live figure is the valuation alone; anything coded
 * DIRECTLY to an inventory account (a write-down, an opening figure — zero
 * rows today) reaches the snapshot at month close but not the live number, so
 * mid-month the relief lags a direct posting by at most one close. Reading the
 * method's full live compute would mean importing lib/finance/balances, which
 * the statement-isolation boundary forbids from the P&L path — a one-close lag
 * on a rare row is the cheaper honest answer.
 *
 * ── Must not import from lib/finance/balances ────────────────────────────────
 * This feeds the frozen P&L path; see scripts/check-statement-isolation.mjs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { inventoryPoolOf, valueInventoryPoolCents, type InventoryPool } from "@/lib/finance/inventoryValuation";
import { monthEnd } from "@/lib/finance/manualEntries";

/**
 * Config key on an inventoryOnHand source row naming the COGS account its
 * monthly change posts against. Declared by the method's setup field
 * (lib/finance/balances/methods/definitions.ts) and read here by the same
 * name. Optional there: an account without it keeps today's behaviour — a
 * balance-sheet figure and no P&L relief.
 */
export const COGS_OFFSET_KEY = "cogsOffsetCoaId";

/** One inventory account that relieves to the P&L. */
export interface InventoryReliefSource {
  /** The inventory (balance-sheet) account. */
  accountCoaId: string;
  /** The COGS account its monthly change posts against. */
  offsetCoaId: string;
  pool: InventoryPool;
}

/** Every active inventory source with a COGS offset configured. */
export async function fetchInventoryReliefSources(supabase: SupabaseClient): Promise<InventoryReliefSource[]> {
  const { data, error } = await supabase
    .from("balance_sheet_account_sources")
    .select("chart_of_accounts_id, config")
    .eq("provider_key", "inventoryOnHand")
    .eq("active", true);
  if (error) throw new Error(`Load inventory sources failed: ${error.message}`);

  const sources: InventoryReliefSource[] = [];
  for (const row of data ?? []) {
    const config = (row.config ?? {}) as Record<string, unknown>;
    const pool = inventoryPoolOf(config["inventoryPool"]);
    const offset = config[COGS_OFFSET_KEY];
    if (!pool || typeof offset !== "string" || offset.length === 0) continue;
    sources.push({ accountCoaId: row.chart_of_accounts_id as string, offsetCoaId: offset, pool });
  }
  return sources;
}

/** One account's value series: stored month-end values, plus a live current month. */
export interface InventoryValueSeries {
  source: InventoryReliefSource;
  /** "YYYY-MM" → value at that month end, internal convention (positive asset). Only months with a real figure appear. */
  valueByMonth: Record<string, number>;
}

/**
 * The month's relief per month of `months`: the change in the account's value,
 * carrying the last known value across gaps. Pure — tested directly.
 */
export function reliefDeltasByMonth(valueByMonth: Record<string, number>, months: string[]): Record<string, number> {
  const known = Object.keys(valueByMonth).sort();
  const valueAt = (month: string): number => {
    let value = 0;
    for (const m of known) {
      if (m <= month) value = valueByMonth[m];
      else break;
    }
    return value;
  };

  const deltas: Record<string, number> = {};
  for (const month of months) {
    const prev = prevMonth(month);
    deltas[month] = valueAt(month) - valueAt(prev);
  }
  return deltas;
}

function prevMonth(month: string): string {
  let [y, m] = month.split("-").map(Number);
  if (--m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * Value series for every relieving account: stored snapshots through
 * `months`' range (plus the month before it, so the first month's delta has a
 * base), and — when `liveMonth` falls inside the range — today's valuation as
 * that month's figure.
 */
export async function fetchInventoryValueSeries(
  supabase: SupabaseClient,
  months: string[],
  liveMonth: string | null,
): Promise<InventoryValueSeries[]> {
  const sources = await fetchInventoryReliefSources(supabase);
  if (sources.length === 0 || months.length === 0) return [];

  // EVERY stored value through the window's end, not just the window: the
  // window's first delta needs the last value BEFORE it as a base, and that
  // base can sit any number of months back when snapshots have gaps. A year
  // whose January re-relieved the whole shelf because the base row fell
  // outside a tidy [first-1, last] fetch is exactly the bug this avoids. A
  // handful of rows per account per year — fetching all of them is nothing.
  const last = months[months.length - 1];
  // The REAL month end, not `${last}-31`: Postgres rejects "2026-04-31"
  // outright, and this fetch sits under retained earnings, so the malformed
  // date took GL 3300 down for every 30-day month it was asked about.
  const { data, error } = await supabase
    .from("gl_account_balances")
    .select("chart_of_accounts_id, period_end, balance_cents")
    .in("chart_of_accounts_id", sources.map((s) => s.accountCoaId))
    .lte("period_end", monthEnd(`${last}-01`));
  if (error) throw new Error(`Load inventory balances failed: ${error.message}`);

  const byAccount = new Map<string, Record<string, number>>();
  for (const row of data ?? []) {
    const month = (row.period_end as string).slice(0, 7);
    const bucket = byAccount.get(row.chart_of_accounts_id as string) ?? {};
    bucket[month] = row.balance_cents as number;
    byAccount.set(row.chart_of_accounts_id as string, bucket);
  }

  // The live month: one valuation per POOL, shared across accounts on it.
  const liveByPool = new Map<InventoryPool, number>();
  if (liveMonth && liveMonth <= last) {
    for (const s of sources) {
      if (!liveByPool.has(s.pool)) liveByPool.set(s.pool, await valueInventoryPoolCents(supabase, s.pool));
    }
  }

  return sources.map((source) => {
    const valueByMonth = { ...(byAccount.get(source.accountCoaId) ?? {}) };
    if (liveMonth && liveByPool.has(source.pool)) valueByMonth[liveMonth] = liveByPool.get(source.pool)!;
    return { source, valueByMonth };
  });
}

/**
 * Cumulative relief through `month`, per COGS offset account — which is, by
 * construction, the inventory VALUE at that month. What retained earnings adds
 * so equity absorbs exactly what the P&L's relief rows recognized.
 */
export async function cumulativeInventoryReliefThrough(
  supabase: SupabaseClient,
  month: string,
  liveMonth: string | null,
): Promise<number> {
  const series = await fetchInventoryValueSeries(supabase, [month], liveMonth);
  let sum = 0;
  for (const s of series) {
    const known = Object.keys(s.valueByMonth).sort();
    let value = 0;
    for (const m of known) if (m <= month) value = s.valueByMonth[m];
    sum += value;
  }
  return sum;
}
