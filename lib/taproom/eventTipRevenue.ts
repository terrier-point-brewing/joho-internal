/**
 * A comped-beer tip settlement is event revenue.
 *
 * When a volunteer's event tip share is settled as comped beer, the business
 * keeps the tip money and hands over product. GL 2310 is relieved by the
 * eventTipSettlements provider; this books the other side as a manual_entries
 * flow row on the account Event Pour sales land on, stamped channel "events"
 * so it files next to the pours in Finance. No tax: the beer was taxed when
 * it was poured, and this is tip money reclassed to income, not a new sale.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Where Event Pour sales are coded (every Event Pour pos line in prod maps here). */
export const EVENT_SALES_ACCOUNT_NUMBER = "4160";
export const EVENT_TIP_COMP_MAPPING_SOURCE = "event_tip_comp";

export function compTipEntryLabel(eventName: string): string {
  return `Event tips kept (comped beer): ${eventName}`;
}

export async function bookCompTipRevenue(
  supabase: SupabaseClient,
  input: { eventName: string; amountCents: number; settledOn: string; note: string | null; userId: string },
): Promise<string> {
  const { data: coa, error: coaErr } = await supabase
    .from("chart_of_accounts")
    .select("id")
    .eq("account_number", EVENT_SALES_ACCOUNT_NUMBER);
  if (coaErr) throw new Error(`event sales account: ${coaErr.message}`);
  if (!coa || coa.length !== 1) {
    throw new Error(`Cannot book comped tips as revenue: expected exactly one GL ${EVENT_SALES_ACCOUNT_NUMBER} account, found ${coa?.length ?? 0}.`);
  }
  const { data, error } = await supabase
    .from("manual_entries")
    .insert({
      entry_kind: "flow",
      chart_of_accounts_id: (coa[0] as { id: string }).id,
      start_date: input.settledOn,
      end_date: input.settledOn,
      amount_cents: input.amountCents,
      label: compTipEntryLabel(input.eventName),
      note: input.note,
      channel: "events",
      mapping_source: EVENT_TIP_COMP_MAPPING_SOURCE,
      created_by: input.userId,
      updated_by: input.userId,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`event tip revenue entry: ${error?.message ?? "no row"}`);
  return (data as { id: string }).id;
}
