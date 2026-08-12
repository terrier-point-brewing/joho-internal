/**
 * The behaviours worth pinning are the four that make these providers safe,
 * rather than the arithmetic, which is a sum:
 *
 *  1. Routing by rate id, not tax name. Live data carries two naming
 *     generations for the same two taxes; matching on the label drops half the
 *     history, and the sum would still look plausible.
 *  2. The channel rule. Tax rows are written for every shipment, so the NC
 *     accrual has to drop wholesale itself or it over-states the moment a
 *     wholesale shipment lands.
 *  3. The floor, declared vs. undeclared. TTB declares a first period and must
 *     honour it; NC declares none and must NOT be floored at its schedule's
 *     creation date, or the accrual disappears while the payments stay.
 *  4. Null over zero, at every step where an answer is genuinely unknown.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ttbExciseAccrual, ncExciseAccrual } from "./exciseAccruals";
import type { BalanceContext } from "../registry";
import type { CoaAccountRef } from "../../financials/types";

const TTB_RATE = "rate-federal";
const NC_RATE = "rate-nc";

interface TaxRow {
  rateId: string;
  amountUsd: number;
  createdAt: string;
  channel: string;
}

/**
 * Stubs the three tables these providers read. The excise chain honours the
 * rate-id filter, the channel filter and the date range, so the routing and
 * the floor are genuinely exercised rather than assumed.
 */
function fakeClient(opts: {
  schedules?: Record<string, Record<string, unknown> | null>;
  rateIdsByParty?: Record<string, string[]>;
  taxes?: TaxRow[];
}) {
  const taxes = opts.taxes ?? [];
  const schedules = opts.schedules ?? {};
  const rateIdsByParty = opts.rateIdsByParty ?? { federal_ttb: [TTB_RATE], nc_dor: [NC_RATE] };

  function scheduleChain() {
    let filingKey = "";
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, v: string) => {
        if (col === "filing_key") filingKey = v;
        return chain;
      },
      maybeSingle: async () => ({ data: schedules[filingKey] ?? null, error: null }),
    };
    return chain;
  }

  function rateChain() {
    let party = "";
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, v: string) => {
        if (col === "party_key") party = v;
        return chain;
      },
      then: undefined,
    };
    // The rate read is awaited directly rather than paginated, so the chain
    // itself must be thenable.
    return Object.assign(chain, {
      then: (resolve: (v: unknown) => void) =>
        resolve({ data: (rateIdsByParty[party] ?? []).map((id) => ({ id })), error: null }),
    });
  }

  function taxChain() {
    let rateIds: string[] = [];
    let channels: string[] = [];
    let lower = "";
    let upper = "￿";
    const chain: Record<string, unknown> = {
      select: () => chain,
      in: (col: string, v: string[]) => {
        if (col === "excise_tax_rate_id") rateIds = v;
        else channels = v;
        return chain;
      },
      gte: (_c: string, v: string) => ((lower = v), chain),
      lt: (_c: string, v: string) => ((upper = v), chain),
      order: () => chain,
      range: async (from: number, to: number) => {
        const hit = taxes.filter(
          (t) =>
            rateIds.includes(t.rateId) &&
            channels.includes(t.channel) &&
            t.createdAt >= lower &&
            t.createdAt < upper,
        );
        return { data: hit.slice(from, to + 1).map((t) => ({ amount_usd: t.amountUsd })), error: null };
      },
    };
    return chain;
  }

  return {
    from: (table: string) => {
      if (table === "tax_schedules") return scheduleChain();
      if (table === "tax_rates") return rateChain();
      if (table === "export_transaction_taxes") return taxChain();
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

const TTB_SCHEDULE = { config: { first_period_start: "2026-07-01" } };
/** NC's real shape: an active schedule that declares no first period. */
const NC_SCHEDULE = { config: {} };
const BOTH = { ttb_beer_excise: TTB_SCHEDULE, nc_dor_beer_excise: NC_SCHEDULE };

function ctx(supabase: SupabaseClient, coaId: string, periodEnd = "2026-07-31"): BalanceContext {
  return { supabase, periodEnd, coaId, config: {} };
}

/** Production's shape in miniature: two pre-obligation months, then July. */
const TAXES: TaxRow[] = [
  { rateId: TTB_RATE, amountUsd: 88.47, createdAt: "2026-05-20T00:00:00Z", channel: "distribution" },
  { rateId: NC_RATE, amountUsd: 485.85, createdAt: "2026-05-20T00:00:00Z", channel: "distribution" },
  { rateId: TTB_RATE, amountUsd: 41.23, createdAt: "2026-06-15T00:00:00Z", channel: "taproom" },
  { rateId: NC_RATE, amountUsd: 225.19, createdAt: "2026-06-15T00:00:00Z", channel: "taproom" },
  { rateId: TTB_RATE, amountUsd: 362.22, createdAt: "2026-07-10T00:00:00Z", channel: "contract_brewing" },
  { rateId: NC_RATE, amountUsd: 1980.64, createdAt: "2026-07-10T00:00:00Z", channel: "contract_brewing" },
];

describe("ttbExciseAccrual", () => {
  it("is offerable on GL 2260 and nowhere else", () => {
    const at = (accountNumber: string) => ttbExciseAccrual.appliesTo!({ accountNumber } as CoaAccountRef);
    expect(at("2260")).toBe(true);
    expect(at("2220")).toBe(false);
  });

  /**
   * Shipment rows are never restated, so unlike `openInvoiceAr` this answers
   * about a closed month honestly -- and must, or GL 2260 drops out of every
   * historical snapshot.
   */
  it("can answer about closed months", () => {
    expect(ttbExciseAccrual.dependsOnCurrentState).toBeFalsy();
  });

  it("sums only the federal rate's rows, honouring the declared first period", async () => {
    const supabase = fakeClient({ schedules: BOTH, taxes: TAXES });

    const result = await ttbExciseAccrual.compute(ctx(supabase, "coa-2260"));

    // July's $362.22 only. May and June total $129.70 and predate the
    // obligation; the NC rows are a different authority entirely.
    expect(result).toBe(-36222);
  });

  it("returns null for a month that closed before the declared first period", async () => {
    const supabase = fakeClient({ schedules: BOTH, taxes: TAXES });

    expect(await ttbExciseAccrual.compute(ctx(supabase, "coa-2260", "2026-06-30"))).toBeNull();
  });

  it("counts every channel, because every removal is federally taxed", async () => {
    const supabase = fakeClient({
      schedules: BOTH,
      taxes: [{ rateId: TTB_RATE, amountUsd: 10, createdAt: "2026-07-10T00:00:00Z", channel: "wholesale" }],
    });

    expect(await ttbExciseAccrual.compute(ctx(supabase, "coa-2260"))).toBe(-1000);
  });

  it("returns null rather than zero when no schedule is active", async () => {
    const supabase = fakeClient({ schedules: {}, taxes: TAXES });

    expect(await ttbExciseAccrual.compute(ctx(supabase, "coa-2260"))).toBeNull();
  });

  it("returns null rather than zero when the authority has no active rate", async () => {
    const supabase = fakeClient({ schedules: BOTH, rateIdsByParty: { federal_ttb: [] }, taxes: TAXES });

    expect(await ttbExciseAccrual.compute(ctx(supabase, "coa-2260"))).toBeNull();
  });

  it("returns null when nothing has shipped since the obligation began", async () => {
    const supabase = fakeClient({ schedules: BOTH, taxes: TAXES.filter((t) => t.createdAt < "2026-07-01") });

    expect(await ttbExciseAccrual.compute(ctx(supabase, "coa-2260"))).toBeNull();
  });
});

describe("ncExciseAccrual", () => {
  it("is offerable on GL 2220 and nowhere else", () => {
    const at = (accountNumber: string) => ncExciseAccrual.appliesTo!({ accountNumber } as CoaAccountRef);
    expect(at("2220")).toBe(true);
    expect(at("2260")).toBe(false);
    expect(at("2250")).toBe(false);
  });

  /**
   * The floor case that matters most. NC's schedule was created in July but
   * its obligation reaches back to the first shipment. Flooring it at the
   * schedule's creation date would drop May and June from the accrual while
   * the payments for those periods stayed in the postings step -- recreating
   * the settled-but-never-accrued asymmetry the method exists to fix.
   */
  it("accrues from the first shipment when no first period is declared", async () => {
    const supabase = fakeClient({ schedules: BOTH, taxes: TAXES });

    const result = await ncExciseAccrual.compute(ctx(supabase, "coa-2220"));

    // 485.85 + 225.19 + 1980.64 = 2691.68, none of it dropped.
    expect(result).toBe(-269168);
  });

  it("excludes wholesale, which the wholesaler remits", async () => {
    const supabase = fakeClient({
      schedules: BOTH,
      taxes: [
        { rateId: NC_RATE, amountUsd: 100, createdAt: "2026-07-10T00:00:00Z", channel: "distribution" },
        { rateId: NC_RATE, amountUsd: 999, createdAt: "2026-07-10T00:00:00Z", channel: "wholesale" },
      ],
    });

    expect(await ncExciseAccrual.compute(ctx(supabase, "coa-2220"))).toBe(-10000);
  });

  it("ignores the federal rate's rows on the same shipments", async () => {
    const supabase = fakeClient({ schedules: BOTH, taxes: TAXES });

    const nc = await ncExciseAccrual.compute(ctx(supabase, "coa-2220"));
    const ttb = await ttbExciseAccrual.compute(ctx(supabase, "coa-2260"));

    // Same shipments, two authorities, no overlap between the two figures.
    expect(nc).toBe(-269168);
    expect(ttb).toBe(-36222);
  });

  it("stops at the month end being computed", async () => {
    const supabase = fakeClient({ schedules: BOTH, taxes: TAXES });

    // Through 30 June: 485.85 + 225.19, July's 1980.64 not yet shipped.
    expect(await ncExciseAccrual.compute(ctx(supabase, "coa-2220", "2026-06-30"))).toBe(-71104);
  });

  it("returns null rather than zero when no schedule is active", async () => {
    const supabase = fakeClient({ schedules: { ttb_beer_excise: TTB_SCHEDULE }, taxes: TAXES });

    expect(await ncExciseAccrual.compute(ctx(supabase, "coa-2220"))).toBeNull();
  });
});
