import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchRefundRoutingRules, resolveRefundAccount, type RoutableOrderLine } from "./refundRouting";

const CONTRA = "coa-4999";
const DEPOSITS = "coa-2420";
const BEER = "coa-4100";
const GIFT = "coa-2410";

function line(coaId: string | null, net: number, tax = 0): RoutableOrderLine {
  return { chartOfAccountsId: coaId, netSalesCents: net, taxCents: tax };
}

describe("resolveRefundAccount", () => {
  /**
   * The refund this whole module was written for.
   *
   * 2026-07-10: a $53.63 refund against a $206.41 four-line taproom ticket. The
   * $53.63 is exactly the Pump Deposit line ($50.00) plus its tax ($3.63); the
   * beer on the same ticket was not refunded. It posted to GL 4999, so the
   * liability for a pump that came back through the door is still on the
   * balance sheet.
   */
  it("routes a deposit refund that matches the deposit line exactly, tax included", () => {
    const lines = [
      line(BEER, 500, 41),
      line(BEER, 900, 74),
      line(DEPOSITS, 5000, 363),
      line("coa-4200", 11900, 863),
    ];
    const rules = new Map([[DEPOSITS, DEPOSITS]]);
    expect(resolveRefundAccount(5363, lines, rules, CONTRA)).toBe(DEPOSITS);
  });

  it("comparing on the net alone would never match — the tax has to be counted", () => {
    // Guards the +taxCents in the sum. Drop it and the real refund above stops
    // matching, silently, and every deposit return goes back to contra-revenue.
    const rules = new Map([[DEPOSITS, DEPOSITS]]);
    expect(resolveRefundAccount(5363, [line(DEPOSITS, 5000, 363)], rules, CONTRA)).toBe(DEPOSITS);
    expect(resolveRefundAccount(5000, [line(DEPOSITS, 5000, 363)], rules, CONTRA)).toBe(CONTRA);
  });

  it("sums several lines on the same routed account", () => {
    // Two kegs on one ticket, both returned.
    const rules = new Map([[DEPOSITS, DEPOSITS]]);
    const lines = [line(DEPOSITS, 3000, 217), line(DEPOSITS, 3000, 217), line(BEER, 900, 74)];
    expect(resolveRefundAccount(6434, lines, rules, CONTRA)).toBe(DEPOSITS);
  });

  it("declines a PARTIAL refund of a routed account", () => {
    // One of two kegs came back, or the amount is a price correction. Nothing
    // here says which, and moving a guessed amount onto a liability account is
    // the failure this module exists to end, not one to introduce from the
    // other side.
    const rules = new Map([[DEPOSITS, DEPOSITS]]);
    const lines = [line(DEPOSITS, 3000, 217), line(DEPOSITS, 3000, 217)];
    expect(resolveRefundAccount(3217, lines, rules, CONTRA)).toBe(CONTRA);
  });

  it("declines when the refund covers the deposit AND some beer", () => {
    const rules = new Map([[DEPOSITS, DEPOSITS]]);
    const lines = [line(DEPOSITS, 5000, 363), line(BEER, 900, 74)];
    expect(resolveRefundAccount(6337, lines, rules, CONTRA)).toBe(CONTRA);
  });

  it("declines when two routed accounts both total the refund amount", () => {
    // Ambiguity loses. Picking either would be a coin flip recorded as an
    // accounting entry.
    const rules = new Map([[DEPOSITS, DEPOSITS], [GIFT, GIFT]]);
    const lines = [line(DEPOSITS, 2000), line(GIFT, 2000)];
    expect(resolveRefundAccount(2000, lines, rules, CONTRA)).toBe(CONTRA);
  });

  it("routes to a DIFFERENT account when the rule says so", () => {
    // The identity mapping is the common shape, not the only one.
    const rules = new Map([[DEPOSITS, "coa-2450"]]);
    expect(resolveRefundAccount(5000, [line(DEPOSITS, 5000)], rules, CONTRA)).toBe("coa-2450");
  });

  it("with no rules configured, behaves exactly as before this module existed", () => {
    expect(resolveRefundAccount(5000, [line(DEPOSITS, 5000)], new Map(), CONTRA)).toBe(CONTRA);
    expect(resolveRefundAccount(5000, [line(DEPOSITS, 5000)], new Map(), null)).toBe(null);
  });

  it("ignores unmapped lines and lines on unrouted accounts", () => {
    const rules = new Map([[DEPOSITS, DEPOSITS]]);
    const lines = [line(null, 5000), line(BEER, 5000), line(DEPOSITS, 3000, 217)];
    expect(resolveRefundAccount(3217, lines, rules, CONTRA)).toBe(DEPOSITS);
    // The unmapped $50 line must not be what a $5000 refund matches against.
    expect(resolveRefundAccount(5000, lines, rules, CONTRA)).toBe(CONTRA);
  });

  it("declines a refund against an order whose lines were not found", () => {
    const rules = new Map([[DEPOSITS, DEPOSITS]]);
    expect(resolveRefundAccount(5363, [], rules, CONTRA)).toBe(CONTRA);
  });

  it("declines a zero or negative refund amount", () => {
    // A $0 line total on a routed account would otherwise "match" a $0 refund.
    const rules = new Map([[DEPOSITS, DEPOSITS]]);
    expect(resolveRefundAccount(0, [line(DEPOSITS, 0)], rules, CONTRA)).toBe(CONTRA);
  });
});

describe("fetchRefundRoutingRules", () => {
  function client(result: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      range: async () => result,
    };
    return { from: () => chain } as unknown as SupabaseClient;
  }

  it("keys active rules by source account", async () => {
    const rules = await fetchRefundRoutingRules(
      client({
        data: [{ source_chart_of_accounts_id: DEPOSITS, target_chart_of_accounts_id: DEPOSITS }],
        error: null,
      }),
    );
    expect(rules.get(DEPOSITS)).toBe(DEPOSITS);
  });

  /**
   * The contract that keeps an unapplied migration from losing refunds.
   *
   * This runs inside the refund webhook and the daily cron. Throwing here would
   * fail the whole sync — every refund in the batch missed, not one mis-coded —
   * so a missing table degrades to "no rules" and refund coding stays exactly
   * as it was. Same rule as accruals.ts's fetchTaxAccountMap.
   */
  it("degrades to no rules when the table is missing", async () => {
    const rules = await fetchRefundRoutingRules(
      client({ data: null, error: { message: 'relation "public.refund_gl_routing" does not exist' } }),
    );
    expect(rules.size).toBe(0);
  });
});
