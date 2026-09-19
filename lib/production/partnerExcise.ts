/**
 * Excise tax billed to partners.
 *
 * On an export invoice, beer excise is a pass-through: the brewery owes it to
 * the state and federal government whoever drinks the beer, and bills the
 * partner for their share as its own line ("Barrel Excise Tax", category
 * `pass_through_taxes`, GL 4330). This sums those lines per partner:
 *
 *   charged    every such line on an invoice that was not voided
 *   collected  the part of that sitting on invoices the partner has paid
 *
 * It reads what was INVOICED, not what was filed — the excise returns are built
 * from shipment records and are a separate question (see the tax module).
 */
export const EXCISE_LINE_CATEGORY = "pass_through_taxes";

export interface ExciseLine { invoice_id: string; total_cents: number | string | null }
export interface ExciseInvoice { id: string; partner_id: string | null; status: string }
export interface PartnerExcise { charged_cents: number; collected_cents: number; outstanding_cents: number; invoices: number }

export function excisePerPartner(invoices: ExciseInvoice[], lines: ExciseLine[]): Record<string, PartnerExcise> {
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const out: Record<string, PartnerExcise> = {};
  const seen = new Map<string, Set<string>>();
  for (const l of lines) {
    const inv = byId.get(l.invoice_id);
    if (!inv || !inv.partner_id || inv.status === "voided") continue;
    const cents = Number(l.total_cents ?? 0);
    const row = (out[inv.partner_id] ??= { charged_cents: 0, collected_cents: 0, outstanding_cents: 0, invoices: 0 });
    row.charged_cents += cents;
    if (inv.status === "paid") row.collected_cents += cents;
    else row.outstanding_cents += cents;
    const ids = seen.get(inv.partner_id) ?? new Set<string>();
    ids.add(inv.id);
    seen.set(inv.partner_id, ids);
    row.invoices = ids.size;
  }
  return out;
}
