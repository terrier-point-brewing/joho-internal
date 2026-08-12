/**
 * GL 2410's two halves, and the reason neither is reachable through
 * `transactionPostings`.
 *
 * Fixtures are shaped from the live production rows: six eGift Card lines
 * totalling $100.00, every one of them carrying its load amount in
 * `gross_sales_cents` with `net_sales_cents` at zero, and three orders paid
 * partly or wholly with a SQUARE_GIFT_CARD tender totalling $50.00.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { giftCardsIssued, giftCardsRedeemed } from "./giftCards";
import type { BalanceContext } from "../registry";

function ctx(supabase: SupabaseClient, periodEnd = "2026-08-31"): BalanceContext {
  return { supabase, periodEnd, coaId: "coa-2410", config: {} } as BalanceContext;
}

/** Records the filters applied so a test can assert on them, and pages one page of rows. */
function recordingClient(rows: unknown[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain: Record<string, unknown> = {
    select: (...args: unknown[]) => { calls.push({ method: "select", args }); return chain; },
    eq: (...args: unknown[]) => { calls.push({ method: "eq", args }); return chain; },
    lt: (...args: unknown[]) => { calls.push({ method: "lt", args }); return chain; },
    contains: (...args: unknown[]) => { calls.push({ method: "contains", args }); return chain; },
    order: () => chain,
    range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
  };
  return { client: { from: () => chain } as unknown as SupabaseClient, calls };
}

describe("giftCardsIssued", () => {
  it("sums the load amount from gross_sales_cents and returns it as a liability", async () => {
    const { client } = recordingClient([
      { gross_sales_cents: 2000 },
      { gross_sales_cents: 1500 },
      { gross_sales_cents: 1500 },
      { gross_sales_cents: 1500 },
      { gross_sales_cents: 2000 },
      { gross_sales_cents: 1500 },
    ]);
    // $100.00 loaded, negative by the internal liability convention.
    expect(await giftCardsIssued.compute(ctx(client))).toBe(-10000);
  });

  /**
   * The reason this provider exists at all.
   *
   * Square zeroes a gift card line's net amount with its own 100% discount,
   * because loading a card is not a sale. `sumPos` reads `net_sales_cents`, so
   * mapping the eGift Card item to 2410 and using Transaction postings would
   * post $0.00 while the liability was real. Reading the WRONG column here
   * reintroduces exactly that, silently.
   */
  it("reads gross_sales_cents, not the net Square zeroes out", async () => {
    // Asserted on the query text rather than on the result, because a fixture
    // carrying both columns would pass whichever one the code picked.
    const probe = recordingClient([{ gross_sales_cents: 2000 }]);
    await giftCardsIssued.compute(ctx(probe.client));
    const selectArgs = probe.calls.find((c) => c.method === "select")?.args[0] as string;
    expect(selectArgs).toContain("gross_sales_cents");
    expect(selectArgs).not.toContain("net_sales_cents");
  });

  it("filters on Square's item_type, not on the catalog name", async () => {
    // "eGift Card" is a label somebody can rename in Square; item_type is
    // Square's own classification of what the line IS.
    const probe = recordingClient([{ gross_sales_cents: 2000 }]);
    await giftCardsIssued.compute(ctx(probe.client));
    const eqs = probe.calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["raw_data->>item_type", "GIFT_CARD"]);
  });

  it("returns null rather than a zero balance when no cards have been sold", async () => {
    const { client } = recordingClient([]);
    expect(await giftCardsIssued.compute(ctx(client))).toBe(null);
  });

  it("is offered only for GL 2410", () => {
    const ref = (accountNumber: string) => ({
      id: "x", parentId: null, accountName: "n", accountNumber, statementSection: "other_current_liabilities",
    });
    expect(giftCardsIssued.appliesTo?.(ref("2410"))).toBe(true);
    expect(giftCardsIssued.appliesTo?.(ref("2420"))).toBe(false);
  });
});

describe("giftCardsRedeemed", () => {
  const order = (tenders: { type: string; amount: number }[]) => ({
    raw_data: {
      tenders: tenders.map((t) => ({ type: t.type, amount_money: { amount: t.amount, currency: "USD" } })),
    },
  });

  it("sums gift card tenders and returns them with the sign that settles the liability", async () => {
    const { client } = recordingClient([
      order([{ type: "SQUARE_GIFT_CARD", amount: 2000 }]),
      order([{ type: "SQUARE_GIFT_CARD", amount: 1500 }]),
      order([{ type: "SQUARE_GIFT_CARD", amount: 1500 }]),
    ]);
    // $50.00 spent. Positive, so it moves a negative liability towards zero.
    expect(await giftCardsRedeemed.compute(ctx(client))).toBe(5000);
  });

  /**
   * The split-tender case, and why this counts the TENDER rather than the order.
   *
   * A $47.78 ticket part-paid by a $20 gift card draws $20 off the liability,
   * not $47.78. Summing `square_orders.total_cents` — the obvious shortcut,
   * since the containment filter already selected the right orders — would
   * overdraw the liability by the card-paid remainder on every mixed ticket.
   */
  it("counts only the gift card portion of a split-tender order", async () => {
    const { client } = recordingClient([
      order([
        { type: "SQUARE_GIFT_CARD", amount: 2000 },
        { type: "CARD", amount: 2778 },
      ]),
    ]);
    expect(await giftCardsRedeemed.compute(ctx(client))).toBe(2000);
  });

  it("returns null rather than a zero balance when no card has been spent", async () => {
    const { client } = recordingClient([]);
    expect(await giftCardsRedeemed.compute(ctx(client))).toBe(null);
  });

  it("tolerates an order whose raw payload carries no tenders", async () => {
    const { client } = recordingClient([{ raw_data: {} }, { raw_data: null }]);
    expect(await giftCardsRedeemed.compute(ctx(client))).toBe(null);
  });
});

describe("the two together", () => {
  /**
   * The GL 2310 trap, asserted rather than trusted to the method definition.
   *
   * Issuance on its own is a liability that grows with every card sold and
   * never comes down. Production today: $100.00 loaded, $50.00 spent, so the
   * outstanding liability is $50.00 — and issuance alone would report double
   * that. The method bundles both steps so "issuance without redemption" is not
   * a state a user can select; this pins the arithmetic that makes the bundling
   * matter.
   */
  it("net to the outstanding balance, which is half what issuance alone reports", async () => {
    const issued = recordingClient([
      { gross_sales_cents: 2000 }, { gross_sales_cents: 1500 }, { gross_sales_cents: 1500 },
      { gross_sales_cents: 1500 }, { gross_sales_cents: 2000 }, { gross_sales_cents: 1500 },
    ]);
    const redeemed = recordingClient([
      { raw_data: { tenders: [{ type: "SQUARE_GIFT_CARD", amount_money: { amount: 2000 } }] } },
      { raw_data: { tenders: [{ type: "SQUARE_GIFT_CARD", amount_money: { amount: 1500 } }] } },
      { raw_data: { tenders: [{ type: "SQUARE_GIFT_CARD", amount_money: { amount: 1500 } }] } },
    ]);

    const a = (await giftCardsIssued.compute(ctx(issued.client))) ?? 0;
    const b = (await giftCardsRedeemed.compute(ctx(redeemed.client))) ?? 0;

    expect(a).toBe(-10000);
    expect(a + b).toBe(-5000);
  });
});
