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
import { firstTrackedMonth, reliefDeltasByMonth, type InventoryValueSeries } from "@/lib/finance/inventoryRelief";
import type { CostOfBeerSoldByMonth } from "@/lib/finance/costOfBeerSold";
import type { SquareFeeSeries } from "@/lib/finance/squareFees";
import { EXCISE_EXPENSE_ACCOUNT_NUMBER } from "@/lib/finance/exciseExpense";

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

/** The operating-expense account the inventory residual posts to: 6460 "Inventory Shrinkage & Adjustments". */
export const INVENTORY_ADJUSTMENTS_ACCOUNT_NUMBER = "6460";

/** Kept for callers that still read the periodic figure: the month's change in inventory. */
export { reliefDeltasByMonth };

/**
 * Inventory on the P&L, three rows that together equal the periodic figure
 * (change in inventory minus purchases) they replaced — so the balance sheet's
 * retained earnings, which adds the cumulative inventory value, still ties:
 *
 *   (Capitalised to inventory)   +purchases, on each COGS offset account —
 *                                 a purchase is an asset, not a cost;
 *   (Cost of beer sold)          −what left this month × its batch cost, on
 *                                 the raw-materials offset (beer) and the
 *                                 packaging offset (packaging);
 *   (Inventory shrinkage & adj.) the residual, on 6460 below gross profit:
 *                                 change − purchases + cost sold. Either
 *                                 sign; a count that finds more is a gain.
 *
 * Opening balances — the first month a shelf has a value — are excluded from
 * the change (reliefDeltasByMonth excludeOpening): equity absorbs them, not
 * the month's P&L. Months up to and INCLUDING the first tracked month get no
 * rows at all: their purchases stay the cost, as they always were. The opening
 * month is the pre-tracking world closing out — its purchases are already in
 * the opening value equity absorbs — so capitalising them while its change is
 * forced to zero dropped the whole month's purchases onto 6460 as a loss
 * ($8.8k in July 2026).
 */
export function injectInventoryCostRows(
  rows: FinancialsRow[],
  series: InventoryValueSeries[],
  costSold: CostOfBeerSoldByMonth,
  months: string[],
  coa: CoaRecord[],
): FinancialsRow[] {
  if (series.length === 0 || months.length === 0) return rows;
  const coaMap = new Map(coa.map((c) => [c.id, c]));
  const trackedFrom = firstTrackedMonth(series);
  if (!trackedFrom) return rows;
  const active = months.filter((m) => m > trackedFrom);
  if (active.length === 0) return rows;

  const offsets = [...new Set(series.map((s) => s.source.offsetCoaId))];
  const offsetFor = (pool: string, fallback: string): string =>
    series.find((s) => s.source.pool === pool)?.source.offsetCoaId ?? fallback;
  const beerOffset = offsetFor("rawMaterials", offsetFor("workInProcess", offsetFor("finishedGoods", offsets[0])));
  const packagingOffset = offsetFor("packagingMaterials", beerOffset);

  const synthesized: FinancialsRow[] = [];
  const zeros = (): Record<string, number> => Object.fromEntries(months.map((m) => [m, 0]));

  // 1. Purchases coded to the offset accounts, reclassified onto the balance sheet.
  const purchasesTotal = zeros();
  for (const coaId of offsets) {
    const amounts = zeros();
    const ids = new Set<string>();
    for (const r of rows) {
      // Every posting on the offset account is a purchase, however it was
      // mapped — a vendor rule maps most of them, and "rule" is also what the
      // derived rows carry, so mappingSource must NOT be the guard here: it
      // left every rule-mapped purchase in COGS on top of the cost of beer
      // sold (double-counted), with the same amount surfacing as a phantom
      // gain on 6460. The only derived rows that can precede this call post
      // elsewhere (depreciation, manual net sales); exclude them by table.
      if (r.coaId !== coaId || r.sourceRef?.table === "depreciation_schedules") continue;
      for (const m of active) {
        const cents = r.amountCentsByMonth[m] ?? 0;
        if (cents === 0) continue;
        amounts[m] -= cents; // expense is negative; the reversal is positive
        for (const id of r.sourceRef.ids ?? []) ids.add(id);
      }
    }
    if (active.every((m) => amounts[m] === 0)) continue;
    for (const m of active) purchasesTotal[m] += amounts[m];
    synthesized.push(synthesizedRow(coaId, "(Capitalised to inventory)", "Capitalised to inventory", "expenses", [...ids], amounts, coaMap));
  }

  // 2. Cost of the beer that left.
  const soldTotal = zeros();
  const beer = zeros();
  const packaging = zeros();
  const soldIds = new Set<string>();
  for (const m of active) {
    const c = costSold[m];
    if (!c) continue;
    beer[m] = -c.beerCents;
    packaging[m] = -c.packagingCents;
    soldTotal[m] = c.beerCents + c.packagingCents;
    for (const id of c.ids) soldIds.add(id);
  }
  const pushSold = (coaId: string, amounts: Record<string, number>) => {
    if (active.every((m) => amounts[m] === 0)) return;
    synthesized.push(synthesizedRow(coaId, "(Cost of beer sold)", "Cost of beer sold", "export_transactions", [...soldIds], amounts, coaMap));
  };
  if (beerOffset === packagingOffset) {
    pushSold(beerOffset, Object.fromEntries(months.map((m) => [m, beer[m] + packaging[m]])));
  } else {
    pushSold(beerOffset, beer);
    pushSold(packagingOffset, packaging);
  }

  // 3. The residual: what the shelves lost or gained that no sale explains.
  const change = zeros();
  const shelfIds = new Set<string>();
  for (const s of series) {
    const deltas = reliefDeltasByMonth(s.valueByMonth, months, { excludeOpening: true });
    for (const m of active) change[m] += deltas[m] ?? 0;
    shelfIds.add(s.source.accountCoaId);
  }
  const adjustments = coa.find((c) => c.accountNumber === INVENTORY_ADJUSTMENTS_ACCOUNT_NUMBER);
  const residual = zeros();
  for (const m of active) residual[m] = change[m] - purchasesTotal[m] + soldTotal[m];
  if (adjustments && active.some((m) => residual[m] !== 0)) {
    synthesized.push(
      synthesizedRow(adjustments.id, "(Inventory shrinkage & adjustments)", "Inventory shrinkage & adjustments", "balance_sheet_account_sources", [...shelfIds], residual, coaMap),
    );
  }
  // Without 6460 the residual has no home and the statements will not tie by
  // exactly that amount — a configuration gap, surfaced rather than hidden.

  return synthesized.length > 0 ? [...rows, ...synthesized] : rows;
}

/** Cumulative depreciation expense through `month` across schedules, internal convention (negative). Retained earnings' half of the tie. */
export function cumulativeDepreciationThrough(states: ScheduleState[], month: string): number {
  let sum = 0;
  for (const state of states) sum += expenseThroughMonth(seriesFor(state, month), month);
  return sum;
}

/**
 * One row for Square's processing fees, negative — a cost. Unlike the two
 * injections above this one runs on BOTH the P&L and the cash-flow statement:
 * a fee is real cash withheld at source, so a cash-flow statement without it
 * overstates operating cash by exactly what the P&L was overstating profit.
 */
export function injectSquareFeeRows(
  rows: FinancialsRow[],
  series: SquareFeeSeries | null,
  months: string[],
  coa: CoaRecord[],
): FinancialsRow[] {
  if (!series || months.length === 0) return rows;
  const coaMap = new Map(coa.map((c) => [c.id, c]));

  const amounts: Record<string, number> = {};
  let hasNonZero = false;
  for (const month of months) {
    const cents = series.feeCentsByMonth[month] ?? 0;
    // `0 - cents`, not `-cents`: negating a zero month produces -0, which fails
    // strict equality in consumers that compare figures with Object.is.
    amounts[month] = 0 - cents;
    if (cents !== 0) hasNonZero = true;
  }
  if (!hasNonZero) return rows;

  return [
    ...rows,
    synthesizedRow(series.coaId, "(Card processing fees)", "Card processing fees", "square_payment_fees", [], amounts, coaMap),
  ];
}

/**
 * One row on GL 6451 (Barrel Excise Taxes Paid): excise accrued per month from
 * the shipment record, in internal P&L convention (negative — a cost).
 * NON-CASH, like depreciation: payments post to the liability accounts when
 * they happen, so the fetch layer supplies this for the P&L alone.
 */
export function injectExciseExpenseRows(
  rows: FinancialsRow[],
  exciseCentsByMonth: Record<string, number> | null,
  months: string[],
  coa: CoaRecord[],
): FinancialsRow[] {
  if (!exciseCentsByMonth || months.length === 0) return rows;
  // Resolved by account number, mirroring the accrual providers' appliesTo.
  // No 6451 in the chart means nowhere to post — skip rather than crash.
  const account = coa.find((c) => c.accountNumber === EXCISE_EXPENSE_ACCOUNT_NUMBER);
  if (!account) return rows;
  const coaMap = new Map(coa.map((c) => [c.id, c]));

  const amounts: Record<string, number> = {};
  let hasNonZero = false;
  for (const month of months) {
    const cents = exciseCentsByMonth[month] ?? 0;
    // `0 - cents`, not `-cents` — see injectSquareFeeRows on -0.
    amounts[month] = 0 - cents;
    if (cents !== 0) hasNonZero = true;
  }
  if (!hasNonZero) return rows;

  return [
    ...rows,
    synthesizedRow(account.id, "(Excise accrued)", "Excise tax accrued", "export_transaction_taxes", [], amounts, coaMap),
  ];
}
