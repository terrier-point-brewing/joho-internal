/**
 * Derived P&L rows: depreciation, and inventory relief. Computed, never
 * posted — the same arrangement as injectManualNetSales, whose row shape this
 * mirrors exactly.
 *
 * ── P&L only, never cash flow ────────────────────────────────────────────────
 * Both rows are NON-CASH. Depreciation is the textbook example; an inventory
 * change is the accrual view of cash already counted when the purchase
 * happened. buildFinancials injects them for statement === "pl" alone, and the
 * direct-method cash-flow statement never sees them — injecting there would
 * misstate operating cash by exactly the amount of the adjustment.
 *
 * ── Retained earnings must absorb what these rows recognize ──────────────────
 * The balance sheet's GL 3300 recomputes net income from the P&L pipeline. If
 * these rows reached the statement but not that provider, every month of
 * depreciation would widen the balancing difference by its own amount — the
 * precise failure the manual-net-sales gap documented in retainedEarnings.ts
 * already exhibits. providers/retainedEarnings.ts therefore adds BOTH
 * cumulative figures, through the same shared modules, in the same change that
 * introduced this file. Do not add a third derived row here without doing the
 * same there.
 *
 * ── This module must not import from lib/finance/balances ────────────────────
 * It feeds the frozen P&L path (scripts/check-statement-isolation.mjs). The
 * depreciation and inventory-relief state modules live in lib/finance proper
 * for exactly this reason.
 */
import type { FinancialsRow } from "./types";
import { coaSection, type CoaRecord } from "./aggregateRows";
import { expenseThroughMonth } from "@/lib/finance/depreciation/engine";
import { seriesFor, type ScheduleState } from "@/lib/finance/depreciation/state";
import { reliefDeltasByMonth, type InventoryValueSeries } from "@/lib/finance/inventoryRelief";

function synthesizedRow(
  coaId: string,
  suffix: string,
  fallbackName: string,
  table: string,
  ids: string[],
  amountCentsByMonth: Record<string, number>,
  coaMap: Map<string, CoaRecord>,
): FinancialsRow {
  const account = coaMap.get(coaId);
  return {
    coaId,
    // The real account's parent — see injectManualNetSales for why a null here
    // breaks buildTree's nesting.
    parentId: account?.parentId ?? null,
    accountName: account ? `${account.accountName} ${suffix}` : fallbackName,
    statementSection: coaSection(account),
    // A derived row has no sales channel, same as a manual entry.
    channel: "unknown",
    posCategory: null,
    kegSize: null,
    amountCentsByMonth,
    bblByMonth: {},
    bblCoverage: "full",
    // A standing rule computed these, no person touched the rows.
    mappingSource: "rule",
    sourceRef: { table, ids },
  };
}

/**
 * One row per depreciation expense account: the schedules' monthly charges
 * over `months`, in internal P&L convention (negative — a cost).
 */
export function injectDepreciationRows(
  rows: FinancialsRow[],
  states: ScheduleState[],
  months: string[],
  coa: CoaRecord[],
): FinancialsRow[] {
  if (states.length === 0 || months.length === 0) return rows;
  const coaMap = new Map(coa.map((c) => [c.id, c]));
  const lastMonth = months[months.length - 1];

  const byExpenseAccount = new Map<string, { amounts: Record<string, number>; ids: Set<string> }>();
  for (const state of states) {
    const series = seriesFor(state, lastMonth);
    const bucket = byExpenseAccount.get(state.expenseChartOfAccountsId) ?? { amounts: {}, ids: new Set<string>() };
    let contributed = false;
    for (const month of months) {
      const cents = series.expenseCentsByMonth[month] ?? 0;
      if (cents === 0) continue;
      bucket.amounts[month] = (bucket.amounts[month] ?? 0) + cents;
      contributed = true;
    }
    if (contributed) bucket.ids.add(state.id);
    byExpenseAccount.set(state.expenseChartOfAccountsId, bucket);
  }

  const synthesized: FinancialsRow[] = [];
  for (const [coaId, bucket] of byExpenseAccount) {
    if (Object.keys(bucket.amounts).length === 0) continue;
    const amounts: Record<string, number> = {};
    for (const month of months) amounts[month] = bucket.amounts[month] ?? 0;
    synthesized.push(
      synthesizedRow(coaId, "(Depreciation)", "Depreciation", "depreciation_schedules", [...bucket.ids], amounts, coaMap),
    );
  }
  return synthesized.length > 0 ? [...rows, ...synthesized] : rows;
}

/**
 * One row per COGS offset account: each month's change in the inventory
 * accounts pointing at it. Inventory up → positive cents (a credit against
 * cost); inventory down → negative (consumed into cost of goods sold).
 */
export function injectInventoryReliefRows(
  rows: FinancialsRow[],
  series: InventoryValueSeries[],
  months: string[],
  coa: CoaRecord[],
): FinancialsRow[] {
  if (series.length === 0 || months.length === 0) return rows;
  const coaMap = new Map(coa.map((c) => [c.id, c]));

  const byOffset = new Map<string, { amounts: Record<string, number>; ids: Set<string> }>();
  for (const s of series) {
    const deltas = reliefDeltasByMonth(s.valueByMonth, months);
    const bucket = byOffset.get(s.source.offsetCoaId) ?? { amounts: {}, ids: new Set<string>() };
    let contributed = false;
    for (const month of months) {
      const cents = deltas[month] ?? 0;
      if (cents === 0) continue;
      bucket.amounts[month] = (bucket.amounts[month] ?? 0) + cents;
      contributed = true;
    }
    if (contributed) bucket.ids.add(s.source.accountCoaId);
    byOffset.set(s.source.offsetCoaId, bucket);
  }

  const synthesized: FinancialsRow[] = [];
  for (const [coaId, bucket] of byOffset) {
    if (Object.keys(bucket.amounts).length === 0) continue;
    const amounts: Record<string, number> = {};
    for (const month of months) amounts[month] = bucket.amounts[month] ?? 0;
    synthesized.push(
      synthesizedRow(coaId, "(Inventory change)", "Inventory change", "balance_sheet_account_sources", [...bucket.ids], amounts, coaMap),
    );
  }
  return synthesized.length > 0 ? [...rows, ...synthesized] : rows;
}

/** Cumulative depreciation expense through `month` across schedules, internal convention (negative). Retained earnings' half of the tie. */
export function cumulativeDepreciationThrough(states: ScheduleState[], month: string): number {
  let sum = 0;
  for (const state of states) sum += expenseThroughMonth(seriesFor(state, month), month);
  return sum;
}
