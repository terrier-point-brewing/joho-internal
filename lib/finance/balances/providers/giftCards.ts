/**
 * GL 2410 Gift Card Liabilities — money customers have handed over for beer
 * they have not drunk yet.
 *
 * ── Why this needs its own providers ─────────────────────────────────────────
 * `transactionPostings` cannot see a gift card, and the reason is worth writing
 * down because it looks like a mapping oversight and is not one.
 *
 * Square models a gift card SALE as a line item with `item_type: "GIFT_CARD"`
 * carrying the load amount in `base_price_money`, and then applies a 100%
 * discount to it, so the line's `total_money` and its net sales are ZERO. That
 * is Square being right: loading a card is not a sale, it is a tender being
 * pre-purchased, and counting it as revenue would book the same money twice —
 * once on load and again when the card buys a beer. But `sumPos` reads
 * `net_sales_cents`, so mapping the eGift Card item to 2410 would post $0.00
 * and the account would read empty while the liability was real.
 *
 * The REDEMPTION half is not in `pos_line_items` at all. Spending a gift card is
 * a tender, not a line: it lands in `square_orders.raw_data.tenders[]` with
 * `type: "SQUARE_GIFT_CARD"`. Nothing in the finance pipeline reads tenders.
 *
 * ── Both halves or neither ───────────────────────────────────────────────────
 * These two providers are only ever offered together, as the `giftCardLiability`
 * method. Issuance alone is the GL 2310 trap exactly: a liability that grows
 * every time a card is sold and never shrinks when one is spent. See
 * methods/registry.ts's header for what that cost the first time.
 *
 * ── What this cannot answer ──────────────────────────────────────────────────
 * This derives the balance from transactions, so it only knows about cards
 * SOLD AND SPENT INSIDE THE SYNC WINDOW. A card sold before the earliest synced
 * order, or sold through a channel these orders do not cover, is invisible —
 * the figure reads LOW, and the method's copy says so rather than implying a
 * reconciled balance. Square does publish authoritative per-card balances
 * through its Gift Cards API; connecting that would turn this into a reported
 * balance like Ramp's rather than a derived one, and is the honest upgrade path.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { registerProvider, sharedRead } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";
import type { CoaAccountRef } from "../../financials/types";

/** Exclusive upper bound: the first instant after periodEnd's calendar day, UTC. Mirrors accruals.ts. */
function exclusiveEnd(periodEnd: string): string {
  const d = new Date(`${periodEnd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/** Square's line-item marker for a gift card load, and its tender type when one is spent. */
const GIFT_CARD_ITEM_TYPE = "GIFT_CARD";
const GIFT_CARD_TENDER_TYPE = "SQUARE_GIFT_CARD";

const isGiftCardAccount = (coa: CoaAccountRef) => coa.accountNumber === "2410";

/**
 * Face value loaded onto gift cards through periodEnd.
 *
 * Filtered on `raw_data->>item_type` rather than on the item's name: "eGift
 * Card" is a catalog label somebody can rename, whereas the item type is
 * Square's own classification of what the line IS. Reads `gross_sales_cents`
 * because that is where the load amount survives — `net_sales_cents` is zeroed
 * by Square's own 100% discount (see the header).
 */
async function fetchGiftCardsIssuedCents(supabase: SupabaseClient, periodEnd: string): Promise<number> {
  const rows = await fetchAllRows<{ gross_sales_cents: number | null }>(() =>
    supabase
      .from("pos_line_items")
      .select("gross_sales_cents, square_orders!inner ( transaction_date, status )")
      .eq("raw_data->>item_type", GIFT_CARD_ITEM_TYPE)
      .eq("square_orders.status", "COMPLETED")
      .lt("square_orders.transaction_date", exclusiveEnd(periodEnd))
      .order("id", { ascending: true }),
  );
  return rows.reduce((s, r) => s + (r.gross_sales_cents ?? 0), 0);
}

/**
 * Gift card value spent through periodEnd.
 *
 * Sums the tender rather than the order: an order part-paid by a $20 card and
 * part by a card reader draws only $20 off the liability, and
 * `square_orders.total_cents` would draw the whole ticket.
 *
 * The tenders live in the order's raw payload, so this reads and filters in JS.
 * That is fine at this scale and honest about the fact that Postgres cannot
 * index into the array cheaply either; if the order table grows past what this
 * can page through, the right fix is a synced `order_tenders` table, not a
 * cleverer query.
 */
async function fetchGiftCardsRedeemedCents(supabase: SupabaseClient, periodEnd: string): Promise<number> {
  const rows = await fetchAllRows<{ raw_data: { tenders?: { type?: string; amount_money?: { amount?: number } }[] } | null }>(() =>
    supabase
      .from("square_orders")
      .select("raw_data")
      .eq("status", "COMPLETED")
      .contains("raw_data", { tenders: [{ type: GIFT_CARD_TENDER_TYPE }] })
      .lt("transaction_date", exclusiveEnd(periodEnd))
      .order("id", { ascending: true }),
  );

  let total = 0;
  for (const row of rows) {
    for (const tender of row.raw_data?.tenders ?? []) {
      if (tender?.type !== GIFT_CARD_TENDER_TYPE) continue;
      total += tender.amount_money?.amount ?? 0;
    }
  }
  return total;
}

export const giftCardsIssued: BalanceProvider = {
  key: "giftCardsIssued",
  label: "Gift cards sold",
  kind: "derived",
  appliesTo: isGiftCardAccount,
  async compute(ctx: BalanceContext): Promise<number | null> {
    const cents = await sharedRead(ctx, `giftCardsIssued:${ctx.periodEnd}`, () =>
      fetchGiftCardsIssuedCents(ctx.supabase, ctx.periodEnd),
    );
    // A would-be $0 is indistinguishable from "no gift cards yet", and negating
    // it would write a zero row that reads as a reconciled nil balance rather
    // than as an account with nothing in it. Same guard as tipAccrual.
    if (cents <= 0) return null;
    // Liability account: negative by the internal convention.
    return -cents;
  },
};

export const giftCardsRedeemed: BalanceProvider = {
  key: "giftCardsRedeemed",
  label: "Gift cards spent",
  kind: "derived",
  appliesTo: isGiftCardAccount,
  async compute(ctx: BalanceContext): Promise<number | null> {
    const cents = await sharedRead(ctx, `giftCardsRedeemed:${ctx.periodEnd}`, () =>
      fetchGiftCardsRedeemedCents(ctx.supabase, ctx.periodEnd),
    );
    if (cents <= 0) return null;
    // Settles the liability, so it moves the balance back TOWARDS zero: the
    // opposite sign to issuance above.
    return cents;
  },
};

registerProvider(giftCardsIssued);
registerProvider(giftCardsRedeemed);
