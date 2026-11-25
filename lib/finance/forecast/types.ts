// Shared shapes for the Financials forecast.
//
// The forecast is a READING of a statement, never part of one. It is computed
// in the browser from the statement rows already on screen plus the small
// `ForecastDrivers` payload below, so nothing here can change what the P&L,
// cash flow or balance sheet report for a month that has happened. Everything
// in this folder except drivers.server.ts is pure and client-safe.

import type { FinancialsRow } from "@/lib/finance/financials/types";

/** The channels beer leaves the brewery through, as export_transactions names them. */
export type DrawdownChannel = "contract_brewing" | "distribution" | "taproom";

export const DRAWDOWN_CHANNELS: DrawdownChannel[] = ["contract_brewing", "distribution", "taproom"];

/** One brewed batch: when it was brewed, how big, and how much has already left. */
export interface DrawdownBatch {
  brewDate: string; // YYYY-MM-DD
  bbl: number;
  shippedBbl: number;
}

export interface ForecastPartner {
  id: string;
  name: string;
  /** This partner's share (0..1) of trailing invoiced revenue in each channel. */
  shareByChannel: Partial<Record<DrawdownChannel, number>>;
}

/** What the server knows that the statement rows do not. Built by drivers.server.ts. */
export interface ForecastDrivers {
  asOf: string; // today, brewery-local YYYY-MM-DD
  openMonth: string; // YYYY-MM
  /** Day spacing of the `curves` arrays. */
  curveStepDays: number;
  /**
   * Per channel: cumulative share of a batch's eventual shipments in that
   * channel that had left by day `i * curveStepDays` after brew day. Starts at
   * 0, ends at 1. Measured on mature batches only, so beer that has not had
   * time to ship cannot make the curve look faster than it is.
   */
  curves: Record<DrawdownChannel, number[]>;
  /** Per channel: shipped bbl ÷ brewed bbl across mature batches. */
  shipFraction: Record<DrawdownChannel, number>;
  /** Batches recent enough to still have beer to ship. */
  batches: DrawdownBatch[];
  /** Brewed bbl per month over the last three ended months. */
  brewPaceBblPerMonth: number;
  /** Actual shipped bbl by channel by month ("YYYY-MM"). */
  shippedBblByMonth: Record<DrawdownChannel, Record<string, number>>;
  /** Accounts a payroll report posts to. */
  payrollCoaIds: string[];
  exciseAccountNumber: string;
  partners: ForecastPartner[];
  cashOnHandCents: number | null;
  /** How many batches the drawdown curve was measured on. */
  matureBatchCount: number;
}

export interface ScenarioItem {
  id: string;
  label: string;
  /** Monthly cost in cents. Negative is extra income. */
  amountCents: number;
  startMonth: string; // YYYY-MM
  recurring: boolean;
}

/** Every lever a reader can move. All percentages are plain percent units; 0 means "as history". */
export interface ForecastAssumptions {
  horizonMonths: 3 | 6 | 12;
  /** null = keep brewing at the historical pace. */
  brewBblPerMonth: number | null;
  /** +20 = beer leaves 20% faster than history. */
  drawdownSpeedPct: number;
  /** +5 = 5% more of each batch is lost before it ships. */
  yieldLossPct: number;
  contractPricePct: number;
  distributionPricePct: number;
  /** Compounding month over month. */
  taproomGrowthPctPerMonth: number;
  ingredientCostPct: number;
  payrollPct: number;
  otherOpexPct: number;
  pausedPartnerIds: string[];
  /** Cash flow only: invoices take this many more days to be paid. */
  extraDaysToCollect: number;
  items: ScenarioItem[];
}

export const BASE_ASSUMPTIONS: ForecastAssumptions = {
  horizonMonths: 3,
  brewBblPerMonth: null,
  drawdownSpeedPct: 0,
  yieldLossPct: 0,
  contractPricePct: 0,
  distributionPricePct: 0,
  taproomGrowthPctPerMonth: 0,
  ingredientCostPct: 0,
  payrollPct: 0,
  otherOpexPct: 0,
  pausedPartnerIds: [],
  extraDaysToCollect: 0,
  items: [],
};

export interface ForecastResult {
  /** The months the forecast is extrapolated from. */
  trailingMonths: string[];
  forecastMonths: string[];
  /** The statement's rows with the forecast months added, plus any scenario rows. */
  rows: FinancialsRow[];
  /** How each line was forecast, keyed by `methodKey`. */
  methodByKey: Record<string, string>;
  revenueCentsByMonth: Record<string, number>;
  netCentsByMonth: Record<string, number>;
  /** Projected shipped bbl, all channels. */
  shippedBblByMonth: Record<string, number>;
  /** Cash flow only: projected cash at each forecast month end. Null when cash on hand is unknown. */
  cashEndCentsByMonth: Record<string, number> | null;
}
