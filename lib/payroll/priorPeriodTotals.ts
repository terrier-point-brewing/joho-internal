/**
 * Prior-period comparison for the payroll Summary tab.
 *
 * The comparison basis is the PRIOR period's locked snapshot (payroll_entries),
 * not a live recompute: a snapshot is what payroll actually paid, and it is
 * cheap to read. An unlocked prior period has no snapshot, so it reports
 * `basis: "unlocked"` and the UI says so rather than showing a fabricated zero.
 *
 * Base pay is rounded once per entry on that employee's summed period hours —
 * the same rule as calculations.ts and periodSummary.computePeriodBasis, so the
 * three agree to the cent.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { pickBaseRate } from "./periodSummary";

/** Snapshot fields the comparison needs. */
export interface SnapshotEntry {
  hours_worked: number | null;
  paycheck_tips_cents: number | null;
  cash_tips_cents: number | null;
  reported_cash_tips_cents: number | null;
  bonus_cents: number | null;
}

export interface PeriodTotals {
  hours: number;
  basePayCents: number;
  paycheckTipsCents: number;
  cashTipsCents: number;
  reportedCashTipsCents: number;
  bonusCents: number;
  /** base + paycheck tips + actual cash tips + bonus */
  totalCompCents: number;
  /** base + paycheck tips + reported cash tips + bonus */
  reportedTotalCompCents: number;
}

export interface PriorPeriodComparison {
  priorPeriod: { id: string; start_date: string; end_date: string; status: string } | null;
  /** null when there is no prior period, or when it has no snapshot yet. */
  totals: PeriodTotals | null;
  basis: "snapshot" | "unlocked" | "none";
}

export function computeSnapshotTotals(entries: SnapshotEntry[], baseRateCents: number): PeriodTotals | null {
  if (entries.length === 0) return null;
  let hours = 0, basePayCents = 0, paycheckTipsCents = 0, cashTipsCents = 0, reportedCashTipsCents = 0, bonusCents = 0;
  for (const e of entries) {
    const h = e.hours_worked ?? 0;
    hours += h;
    basePayCents += Math.round(h * baseRateCents);
    paycheckTipsCents += e.paycheck_tips_cents ?? 0;
    cashTipsCents += e.cash_tips_cents ?? 0;
    // Older snapshots predate reported cash tips; fall back to the actual so
    // the reported view compares against something real rather than zero.
    reportedCashTipsCents += e.reported_cash_tips_cents ?? e.cash_tips_cents ?? 0;
    bonusCents += e.bonus_cents ?? 0;
  }
  const wages = basePayCents + paycheckTipsCents + bonusCents;
  return {
    hours,
    basePayCents,
    paycheckTipsCents,
    cashTipsCents,
    reportedCashTipsCents,
    bonusCents,
    totalCompCents: wages + cashTipsCents,
    reportedTotalCompCents: wages + reportedCashTipsCents,
  };
}

/** The period immediately before `periodId` by start_date, with its snapshot totals. */
export async function getPriorPeriodComparison(
  sb: SupabaseClient,
  periodId: string,
): Promise<PriorPeriodComparison> {
  const { data: current, error: cErr } = await sb
    .from("pay_periods")
    .select("id, start_date")
    .eq("id", periodId)
    .single();
  if (cErr) throw new Error(`Load pay period failed: ${cErr.message}`);

  const { data: prior } = await sb
    .from("pay_periods")
    .select("id, start_date, end_date, status")
    .lt("start_date", (current as { start_date: string }).start_date)
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!prior) return { priorPeriod: null, totals: null, basis: "none" };
  const p = prior as { id: string; start_date: string; end_date: string; status: string };

  const [{ data: entryRows }, { data: configRows }] = await Promise.all([
    sb
      .from("payroll_entries")
      .select("hours_worked, paycheck_tips_cents, cash_tips_cents, reported_cash_tips_cents, bonus_cents")
      .eq("pay_period_id", p.id),
    sb.from("payroll_config").select("effective_from, base_rate_cents"),
  ]);

  const totals = computeSnapshotTotals(
    (entryRows ?? []) as SnapshotEntry[],
    pickBaseRate((configRows ?? []) as { effective_from: string; base_rate_cents: number }[], p.start_date),
  );

  return { priorPeriod: p, totals, basis: totals ? "snapshot" : "unlocked" };
}
