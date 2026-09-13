import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Ingredient deposits collected on export invoices, per allocation.
 *
 * A contract allocation whose deposit was never paid up front has its share
 * added to each export invoice as the beer ships (`allocation_deposit_charges`,
 * one row per invoice). Paid/voided is read from the invoice on every call —
 * the charge row never copies it — so a voided invoice simply stops counting.
 */
export interface DepositChargesSummary {
  /** Cents on non-voided invoices (paid or still open). */
  chargedCents: number;
  /** Cents on PAID invoices. */
  collectedCents: number;
  /** Invoices carrying a charge that are not yet paid (and not voided). */
  unpaidCount: number;
  /** bbl those charges were computed on (non-voided). */
  chargedBbl: number;
  /** Ledger invoice ids, newest first, for badges. */
  invoiceIds: string[];
}

export const EMPTY_CHARGES: DepositChargesSummary = {
  chargedCents: 0, collectedCents: 0, unpaidCount: 0, chargedBbl: 0, invoiceIds: [],
};

interface ChargeRow {
  allocation_id: string;
  invoice_id: string;
  amount_cents: number | null;
  shipped_bbl: number | string | null;
  created_at?: string | null;
  invoices: { status: string | null } | { status: string | null }[] | null;
}

/** Pure fold, exported for tests. */
export function summarizeDepositCharges(rows: ChargeRow[]): Map<string, DepositChargesSummary> {
  const out = new Map<string, DepositChargesSummary>();
  const sorted = [...rows].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  for (const r of sorted) {
    const invRaw = r.invoices;
    const inv = Array.isArray(invRaw) ? invRaw[0] : invRaw;
    const status = inv?.status ?? null;
    if (status === "voided") continue;
    const s = out.get(r.allocation_id) ?? { ...EMPTY_CHARGES, invoiceIds: [] };
    const cents = Number(r.amount_cents ?? 0);
    s.chargedCents += cents;
    s.chargedBbl += Number(r.shipped_bbl ?? 0);
    if (status === "paid") s.collectedCents += cents;
    else s.unpaidCount += 1;
    s.invoiceIds.push(r.invoice_id);
    out.set(r.allocation_id, s);
  }
  return out;
}

/**
 * Load charge summaries for a set of allocations. Pass the ADMIN client: the
 * table sits in the invoices RLS cluster, so a brewer's own client reads it as
 * empty and the deposit would look uncharged.
 */
export async function loadDepositCharges(
  admin: SupabaseClient,
  allocationIds: string[],
): Promise<Map<string, DepositChargesSummary>> {
  if (allocationIds.length === 0) return new Map();
  const { data } = await admin
    .from("allocation_deposit_charges")
    .select("allocation_id, invoice_id, amount_cents, shipped_bbl, created_at, invoices!invoice_id(status)")
    .in("allocation_id", allocationIds);
  return summarizeDepositCharges((data ?? []) as unknown as ChargeRow[]);
}
