import { describe, it, expect } from "vitest";
import {
  planRefund,
  lineBasis,
  consequencesFor,
  type RefundableLine,
  type RefundPlanInput,
} from "./refundPlanner";

/** A keg line: 10 kegs at $150, 10 x 1/6 bbl. */
const beer: RefundableLine = {
  id: "beer",
  category: "distribution_keg",
  quantity: 10,
  unitPriceCents: 15000,
  totalCents: 150000,
  volumeBbl: 1.7,
};

/** Excise, as Square actually carries it: quantity 1, whole amount in the price. */
const excise: RefundableLine = {
  id: "excise",
  category: "pass_through_taxes",
  quantity: 1,
  unitPriceCents: 5950,
  totalCents: 5950,
};

/** Packaging Fee is billed PER KEG in prod (quantities of 3-83), so per_unit. */
const packagingFee: RefundableLine = {
  id: "pkgfee",
  category: "packaging_fees",
  quantity: 10,
  unitPriceCents: 2000,
  totalCents: 20000,
};

const forklift: RefundableLine = {
  id: "forklift",
  category: "other_services",
  quantity: 1,
  unitPriceCents: 7500,
  totalCents: 7500,
};

const materials: RefundableLine = {
  id: "materials",
  category: "materials_packaging",
  quantity: 1,
  unitPriceCents: 4000,
  totalCents: 4000,
};

function input(over: Partial<RefundPlanInput> = {}): RefundPlanInput {
  return {
    lines: [beer, excise, packagingFee, forklift],
    selections: [],
    reason: "price_correction",
    paidCents: 183450,
    alreadyRefundedCents: 0,
    ...over,
  };
}

const ok = (p: ReturnType<typeof planRefund>) => {
  if (!p.ok) throw new Error(`expected a plan, got: ${p.error}`);
  return p;
};

describe("lineBasis", () => {
  it("calls excise and materials derived even though both are quantity 1", () => {
    expect(lineBasis(excise)).toBe("derived");
    expect(lineBasis(materials)).toBe("derived");
  });

  it("calls a quantity-1 service line flat, not derived", () => {
    expect(lineBasis(forklift)).toBe("flat");
  });

  it("calls the per-keg packaging fee per_unit", () => {
    expect(lineBasis(packagingFee)).toBe("per_unit");
  });
});

describe("consequencesFor", () => {
  it("moves no stock and no excise on a price correction", () => {
    expect(consequencesFor("price_correction")).toEqual({
      recreditsInventory: false,
      reversesExcise: false,
    });
  });

  it("reverses both when the beer came back or never left", () => {
    for (const r of ["goods_returned", "never_delivered"] as const) {
      expect(consequencesFor(r)).toEqual({ recreditsInventory: true, reversesExcise: true });
    }
  });
});

describe("planRefund — the overcharge case", () => {
  it("credits beer only, and leaves the excise alone", () => {
    const plan = ok(
      planRefund(
        input({ selections: [{ lineId: "beer", quantity: 2 }], reason: "price_correction" }),
      ),
    );
    expect(plan.lines.map((l) => l.lineId)).toEqual(["beer"]);
    expect(plan.totalCents).toBe(30000);
    expect(plan.reversesExcise).toBe(false);
  });

  it("prices off what was paid, not the list unit price", () => {
    // Same 10 kegs, but $1,200 actually paid after a bulk discount.
    const discounted = { ...beer, totalCents: 120000 };
    const plan = ok(
      planRefund(
        input({
          lines: [discounted, excise],
          selections: [{ lineId: "beer", quantity: 5 }],
          paidCents: 125950,
        }),
      ),
    );
    expect(plan.totalCents).toBe(60000); // half of 120000, not half of 150000
  });
});

describe("planRefund — derived lines", () => {
  it("scales excise by volume, not by units or dollars, when beer comes back", () => {
    const plan = ok(
      planRefund(
        input({ selections: [{ lineId: "beer", quantity: 5 }], reason: "goods_returned" }),
      ),
    );
    const exciseLine = plan.lines.find((l) => l.lineId === "excise");
    expect(exciseLine?.amountCents).toBe(2975); // half the volume, half the excise
    expect(exciseLine?.quantity).toBeNull();
    expect(plan.reversesExcise).toBe(true);
  });

  it("refuses to credit excise when the beer lines carry no volume", () => {
    const noVolume = { ...beer, volumeBbl: null };
    const plan = planRefund(
      input({
        lines: [noVolume, excise],
        selections: [{ lineId: "beer", quantity: 5 }],
        reason: "goods_returned",
        paidCents: 155950,
      }),
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/excise filing/);
  });

  it("shrinks an invoice discount in step, so the credit never exceeds what was paid", () => {
    const discount: RefundableLine = {
      id: "discount",
      category: "discount",
      quantity: 1,
      unitPriceCents: -10000,
      totalCents: -10000,
    };
    const plan = ok(
      planRefund(
        input({
          lines: [beer, discount],
          selections: [{ lineId: "beer", quantity: 10 }],
          paidCents: 140000,
        }),
      ),
    );
    expect(plan.totalCents).toBe(140000); // 150000 credited, less the 10000 discount
  });

  it("scales materials by units", () => {
    const plan = ok(
      planRefund(
        input({
          lines: [beer, materials],
          selections: [{ lineId: "beer", quantity: 5 }],
          paidCents: 154000,
        }),
      ),
    );
    expect(plan.lines.find((l) => l.lineId === "materials")?.amountCents).toBe(2000);
  });
});

describe("planRefund — guards", () => {
  it("G2: rejects crediting excise on its own", () => {
    const plan = planRefund(
      input({ selections: [{ lineId: "excise" }], reason: "goods_returned" }),
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/recalculate from the beer lines/);
  });

  it("G1: rejects a credit exceeding what is left refundable", () => {
    const plan = planRefund(
      input({
        selections: [{ lineId: "beer", quantity: 10 }],
        alreadyRefundedCents: 100000,
      }),
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/remain refundable/);
  });

  it("rejects crediting more units than were billed", () => {
    const plan = planRefund(input({ selections: [{ lineId: "beer", quantity: 11 }] }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/only billed 10/);
  });

  it("rejects a line that is not on the invoice", () => {
    const plan = planRefund(input({ selections: [{ lineId: "nope", quantity: 1 }] }));
    expect(plan.ok).toBe(false);
  });

  it("rejects an empty selection", () => {
    expect(planRefund(input()).ok).toBe(false);
  });

  it("rejects a zero or negative quantity", () => {
    expect(planRefund(input({ selections: [{ lineId: "beer", quantity: 0 }] })).ok).toBe(false);
  });

  it("G4: refuses to plan a deposit reduction from invoice lines", () => {
    const plan = planRefund(
      input({ selections: [{ lineId: "beer", quantity: 1 }], reason: "deposit_reduction" }),
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/planned from the allocation/);
  });

  it("credits a flat line in full, with no quantity", () => {
    const plan = ok(planRefund(input({ selections: [{ lineId: "forklift" }] })));
    expect(plan.lines[0]).toEqual({
      lineId: "forklift",
      basis: "flat",
      quantity: null,
      amountCents: 7500,
    });
  });
});

/**
 * Invoice 000042 (Argus Beverage Ventures) as it actually exists in prod: a
 * contract-brewing invoice with NO product line. 30 cases of Pumpkin Ale
 * packaged, 2.9032 bbl shipped, $548.60 total.
 *
 * Eight cases were taken back, and the refund was issued by hand in Square for
 * $144.96. These assertions are the planner reproducing that number from first
 * principles — if it drifts, the planner and the brewery disagree about what a
 * partial refund is worth.
 */
describe("planRefund — prod invoice 000042, 8 cases of Pumpkin Ale", () => {
  const CASES = 30;
  const VOLUME_BBL = 2.9032;

  const packagingFee: RefundableLine = {
    id: "pkgfee",
    category: "packaging_fees",
    quantity: CASES,
    unitPriceCents: 900,
    totalCents: 27000,
    volumeBbl: VOLUME_BBL, // the per-case line IS the volume line here
  };
  const exciseTtb: RefundableLine = {
    id: "excise_ttb",
    category: "pass_through_taxes",
    quantity: 1,
    unitPriceCents: 1016,
    totalCents: 1016,
  };
  const exciseNc: RefundableLine = {
    id: "excise_nc",
    category: "pass_through_taxes",
    quantity: 1,
    unitPriceCents: 5554,
    totalCents: 5554,
  };
  const forkliftFee: RefundableLine = {
    id: "forklift",
    category: "other_services",
    quantity: 1,
    unitPriceCents: 500,
    totalCents: 500,
  };
  const materialsLine: RefundableLine = {
    id: "materials",
    category: "materials_packaging",
    quantity: 1,
    unitPriceCents: 20790,
    totalCents: 20790,
  };

  const invoice = [packagingFee, exciseTtb, exciseNc, forkliftFee, materialsLine];

  it("reproduces the $144.96 that was refunded by hand", () => {
    const plan = ok(
      planRefund({
        lines: invoice,
        selections: [{ lineId: "pkgfee", quantity: 8 }],
        reason: "goods_returned",
        paidCents: 54860,
        alreadyRefundedCents: 0,
      }),
    );

    expect(Object.fromEntries(plan.lines.map((l) => [l.lineId, l.amountCents]))).toEqual({
      pkgfee: 7200,      // 8 of 30 cases at $9
      materials: 5544,   // 8/30 of $207.90
      excise_ttb: 271,   // 8/30 of the volume
      excise_nc: 1481,
    });
    expect(plan.totalCents).toBe(14496);
    expect(plan.recreditsInventory).toBe(true);
    expect(plan.reversesExcise).toBe(true);
  });

  it("does not let the flat forklift fee into the unit fraction", () => {
    // 8/31 instead of 8/30 would put materials at 5365, not 5544.
    const plan = ok(
      planRefund({
        lines: invoice,
        selections: [{ lineId: "pkgfee", quantity: 8 }],
        reason: "goods_returned",
        paidCents: 54860,
        alreadyRefundedCents: 0,
      }),
    );
    expect(plan.lines.find((l) => l.lineId === "materials")?.amountCents).toBe(5544);
  });

  it("leaves both excise lines alone if the same 8 cases were only overpriced", () => {
    const plan = ok(
      planRefund({
        lines: invoice,
        selections: [{ lineId: "pkgfee", quantity: 8 }],
        reason: "price_correction",
        paidCents: 54860,
        alreadyRefundedCents: 0,
      }),
    );
    expect(plan.lines.map((l) => l.lineId).sort()).toEqual(["materials", "pkgfee"]);
    expect(plan.totalCents).toBe(12744);
  });
});
