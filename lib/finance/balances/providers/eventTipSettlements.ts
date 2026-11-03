// Event tips settled OUTSIDE payroll, relieving GL 2310.
//
// GL 2310 Undistributed Tips accrues every tip on a completed Square order
// (tipAccrual) and is relieved by the postings coded to it -- which is how a
// paycheck tip reaches the books through Gusto. An event's tips are carved
// out of the taproom tip pool at source (lib/square/payroll.ts) and settled
// per event on the Events tab (event_tip_payouts). A payout settled THROUGH
// payroll still relieves 2310 via Gusto's postings like any other paycheck
// tip. A payout settled any other way -- cash handed to a volunteer, beer
// comped in lieu, "other" -- never touches payroll, so without this step the
// liability would carry those tips forever. This provider is that step: the
// sum of non-payroll event tip settlements on or before period end.
//
// Internal convention: a liability is negative, so relieving it is positive.
// Degrades to null when the table is not there yet (unapplied migration),
// matching tipAccrual's contract.
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerProvider, type BalanceContext, type BalanceProvider } from "../registry";
import { fetchAllRows } from "@/lib/supabase/paginate";

export async function fetchEventTipSettlementCents(
  supabase: SupabaseClient,
  periodEnd: string,
): Promise<number | null> {
  try {
    const rows = await fetchAllRows<{ amount_cents: number | null }>(() =>
      supabase
        .from("event_tip_payouts")
        .select("amount_cents")
        .neq("method", "payroll")
        .lte("settled_on", periodEnd)
        .order("id", { ascending: true }),
    );
    return rows.reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  } catch {
    return null;
  }
}

export const eventTipSettlements: BalanceProvider = {
  key: "eventTipSettlements",
  label: "Event tips settled outside payroll",
  kind: "derived",
  appliesTo: (coa) => coa.accountNumber === "2310",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const cents = await fetchEventTipSettlementCents(ctx.supabase, ctx.periodEnd);
    if (cents == null || cents <= 0) return null;
    return cents;
  },
};

registerProvider(eventTipSettlements);
