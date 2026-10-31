// Wire shapes of /api/partner/*. Kept apart from lib/partner/*.server so the
// client bundle never reaches a server module.

export interface MonthCapacity { month: string; open_slots: number; earliest_start: string | null; max_turns: number }
export interface ClaimableBatch { batch_id: string; beer_name: string; style: string | null; abv: number | null; ready_by: string | null; packaged: boolean; claimable_bbl: number; ready_now_bbl: number; in_tank_bbl: number; stage: "in_tank" | "packaging" | "packaged" }
export interface OwnRecipe { id: string; beer_name: string; style: string | null }
export interface Overview {
  company_name: string; preview: boolean; turn_bbl: number; max_turns: number;
  capacity: MonthCapacity[]; available: ClaimableBatch[]; recipes: OwnRecipe[];
}
export interface BrewWindow { week_of: string; ready_around: string }
export interface RequestOffer { pct: number; bbl: number; note: string | null; offered_at: string | null; answered_at: string | null }
export interface PortalRequest {
  id: string; kind: "batch" | "claim"; beer_name: string; is_new_beer: boolean; turns: number | null; volume_bbl: number;
  /** Batch requests: the beer actually wanted and the share of the brew it is. Claims: null. */
  wanted_bbl: number | null; share_pct: number | null;
  /** The brewery's counter-offer, if one was ever made. Waiting on the partner while status is "adjusted". */
  offer: RequestOffer | null;
  desired_date: string | null; notes: string | null; status: "submitted" | "adjusted" | "approved" | "declined" | "withdrawn";
  decision_note: string | null; decided_at: string | null; created_at: string; file_names: string[];
  submitted_by: string | null; withdrawn_by: string | null;
}
export type PaymentStatus = "paid" | "unpaid" | "not_invoiced";
export interface PortalInvoice { id: string; number: string | null; date: string | null; kind: "shipment" | "deposit"; status: "paid" | "unpaid"; total_cents: number; beers: string[]; bbl: number; due_date: string | null; overdue: boolean; days_overdue: number; pay_url: string | null; /** Money sent back against this invoice, completed or in flight. */ refunded_cents: number }
/**
 * Money we sent back. Reasons are the partner-facing words, never the code;
 * null while we have not yet said why (a refund made from the Square dashboard
 * by hand). Lines are present only when the app issued the refund.
 */
export interface PortalRefund {
  id: string; date: string | null; amount_cents: number; status: "completed" | "processing";
  reason: string | null; invoice: { id: string; number: string | null } | null;
  lines: Array<{ label: string; quantity: number | null; amount_cents: number }>;
}
export interface DealProgress { step: number; label: string; brew_date: string | null; ready_by: string | null }
export const PROGRESS_STEPS = ["Scheduled", "Brewing", "Fermenting", "Conditioning", "Packaging", "Ready"] as const;
export interface PortalShipment {
  kind: "shipment" | "return"; date: string; volume_bbl: number; lines: Array<{ label: string | null; quantity: number }>;
  payment: PaymentStatus; invoice: PortalInvoice | null;
}
export interface PortalDeal {
  id: string; beer_name: string | null; status: "open" | "closed" | "cancelled"; booked_bbl: number; produced_bbl: number; expected_bbl: number; has_batch: boolean; progress: DealProgress; shipped_bbl: number;
  remaining_bbl: number; in_tank_bbl: number; style?: string | null; desired_delivery_date: string | null; received_on: string | null;
  deposit: { billed_cents: number; paid_cents: number; status: PaymentStatus; invoice: PortalInvoice | null; billed_on: "own_invoice" | "shipment_invoice" | null } | null;
  shipments: PortalShipment[];
  /** Every invoice on this deal (deposit, shipments, back-charges) still to be paid — one entry per invoice. */
  unpaid_invoices: PortalInvoice[];
  /** Refunds against this deal's invoices or its deposit, newest first. */
  refunds: PortalRefund[];
}
export interface PortalHistory {
  summary: { shipped_bbl: number; paid_cents: number; outstanding_cents: number; overdue_cents: number; open_deals: number; to_come_bbl: number; refunded_cents: number };
  excise: { charged_cents: number; collected_cents: number; outstanding_cents: number; invoices: number };
  open_invoices: PortalInvoice[];
  deals: PortalDeal[];
  other_shipments: PortalShipment[];
  /** Every refund to this partner, newest first. */
  refunds: PortalRefund[];
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
/**
 * The message behind a failed portal call. Routes answer `{ error }` as JSON,
 * but the sign-in guard answers plain text — read either, never swallow it.
 */
export async function apiError(res: Response, fallback: string): Promise<string> {
  const body = await res.text().catch(() => "");
  try { return (JSON.parse(body) as { error?: string }).error || fallback; } catch { return body.trim() || fallback; }
}
/** One decimal — for headline figures, where 25.61 reads as false precision. */
export const bbl1 = (n: number) => `${n.toFixed(1)} bbl`;
export const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
