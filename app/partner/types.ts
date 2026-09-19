// Wire shapes of /api/partner/*. Kept apart from lib/partner/*.server so the
// client bundle never reaches a server module.

export interface MonthCapacity { month: string; open_slots: number; earliest_start: string | null; max_turns: number }
export interface ClaimableBatch { batch_id: string; beer_name: string; style: string | null; abv: number | null; ready_by: string | null; packaged: boolean; claimable_bbl: number }
export interface OwnRecipe { id: string; beer_name: string; style: string | null }
export interface Overview {
  company_name: string; preview: boolean; turn_bbl: number; max_turns: number;
  capacity: MonthCapacity[]; available: ClaimableBatch[]; recipes: OwnRecipe[];
}
export interface BrewWindow { week_of: string; ready_around: string }
export interface PortalRequest {
  id: string; kind: "batch" | "claim"; beer_name: string; is_new_beer: boolean; turns: number | null; volume_bbl: number;
  desired_date: string | null; notes: string | null; status: "submitted" | "approved" | "declined" | "withdrawn";
  decision_note: string | null; decided_at: string | null; created_at: string; file_names: string[];
}
export type PaymentStatus = "paid" | "unpaid" | "not_invoiced";
export interface PortalInvoice { id: string; number: string | null; date: string | null; kind: "shipment" | "deposit"; status: "paid" | "unpaid"; total_cents: number; beers: string[]; bbl: number }
export interface PortalShipment {
  date: string; volume_bbl: number; lines: Array<{ label: string | null; quantity: number }>;
  payment: PaymentStatus; invoice: PortalInvoice | null;
}
export interface PortalDeal {
  id: string; beer_name: string | null; status: "open" | "closed" | "cancelled"; booked_bbl: number; shipped_bbl: number;
  remaining_bbl: number; in_tank_bbl: number; style?: string | null; desired_delivery_date: string | null; received_on: string | null;
  deposit: { billed_cents: number; paid_cents: number; status: PaymentStatus } | null;
  shipments: PortalShipment[];
}
export interface PortalHistory {
  summary: { shipped_bbl: number; paid_cents: number; outstanding_cents: number; open_deals: number; to_come_bbl: number };
  excise: { charged_cents: number; collected_cents: number; outstanding_cents: number; invoices: number };
  open_invoices: PortalInvoice[];
  deals: PortalDeal[];
  other_shipments: PortalShipment[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-06" → "Oct 6". Pure string work: a date has no timezone to drift in. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "—";
  return `${MONTHS[m - 1]} ${d}`;
}
export function longDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${shortDate(iso)}, ${iso.slice(0, 4)}`;
}
/** "2026-10" → "October 2026" */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${LONG_MONTHS[m - 1]} ${y}`;
}
export const bbl = (n: number) => `${Number(n.toFixed(2))} bbl`;
/** One decimal — for headline figures, where 25.61 reads as false precision. */
export const bbl1 = (n: number) => `${n.toFixed(1)} bbl`;
export const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
