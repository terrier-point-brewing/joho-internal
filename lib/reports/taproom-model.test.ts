import { describe, it, expect } from "vitest";
import { buildTaproomModelReport } from "./taproom-model";
import { KEG_TRANSFER_DISCOUNT_NAME } from "@/types/reports";
import type { SquareRefund } from "@/lib/square/refunds";
import type { CatalogItem, Order, OrderLineItem, OrderReturn, OrderReturnLineItem } from "@/types/square";

const KEGS_CAT = "FXHTXXAICGRPMGJAHGJZ34MY";
const DRAFT_CAT = "567KQPEBRBZHG7ATHQFRCRWZ";
const COCKTAIL_CAT = "IPD6T7FOCCZBXG2HOPOVFB4J";
const MERCH_CAT = "QDY242ULK5TF5GNWOSOZ2KG4";
const SNACKS_CAT = "VS5QIJ7EH56OXJ3OOMNCJVHP"; // → NA_SNACKS

function makeItem(opts: {
  id: string;
  name: string;
  categoryId: string;
  productType?: string;
  variations: { id: string; name: string; priceCents?: number }[];
  slots?: string[][];
}): CatalogItem {
  return {
    type: "ITEM",
    id: opts.id,
    item_data: {
      name: opts.name,
      product_type: opts.productType ?? "FOOD_AND_BEV",
      reporting_category: { id: opts.categoryId, ordinal: 0 },
      variations: opts.variations.map((v) => ({
        type: "ITEM_VARIATION",
        id: v.id,
        item_variation_data: {
          item_id: opts.id,
          name: v.name,
          ...(v.priceCents !== undefined ? { price_money: { amount: v.priceCents, currency: "USD" } } : {}),
        },
      })),
      ...(opts.slots
        ? { combo_type_details: { slots: opts.slots.map((ids, i) => ({ uid: `s${i}`, name: `S${i}`, num_selections: 1, item_variation_ids: ids })) } }
        : {}),
    },
  };
}

function line(opts: Partial<OrderLineItem> & { uid: string }): OrderLineItem {
  return { quantity: opts.quantity ?? "1", name: opts.name ?? "X", ...opts };
}

function order(id: string, lines: OrderLineItem[], extra: Partial<Order> = {}): Order {
  return {
    id,
    location_id: "L1",
    state: "COMPLETED",
    created_at: "2026-06-01T00:00:00Z",
    closed_at: "2026-06-01T01:00:00Z",
    line_items: lines,
    ...extra,
  };
}

function refund(orderId: string, amount: number): SquareRefund {
  return {
    id: `r-${orderId}`,
    order_id: orderId,
    amount_money: { amount, currency: "USD" },
  } as SquareRefund;
}

describe("buildTaproomModelReport — bucketing", () => {
  const items = [
    makeItem({ id: "d1", name: "Citra Haze", categoryId: DRAFT_CAT, variations: [{ id: "draftv", name: "Pint" }] }),
    makeItem({ id: "m1", name: "Tee Shirt", categoryId: MERCH_CAT, variations: [{ id: "merchv", name: "L" }] }),
    makeItem({ id: "s1", name: "Pretzel", categoryId: SNACKS_CAT, variations: [{ id: "snackv", name: "Each" }] }),
  ];

  it("buckets line items into their model categories with net = gross - discounts - returns", () => {
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "draftv", gross_sales_money: { amount: 800, currency: "USD" }, total_discount_money: { amount: 100, currency: "USD" }, total_tax_money: { amount: 60, currency: "USD" } }),
      line({ uid: "b", catalog_object_id: "merchv", gross_sales_money: { amount: 2500, currency: "USD" } }),
      line({ uid: "c", catalog_object_id: "snackv", gross_sales_money: { amount: 500, currency: "USD" } }),
    ]);
    const { byCategory } = buildTaproomModelReport([o], items, []);
    expect(byCategory.DRAFT_BEER.grossSalesCents).toBe(800);
    expect(byCategory.DRAFT_BEER.discountsCents).toBe(100);
    expect(byCategory.DRAFT_BEER.taxCents).toBe(60);
    expect(byCategory.DRAFT_BEER.netSalesCents).toBe(700);
    expect(byCategory.MERCHANDISE.netSalesCents).toBe(2500);
    expect(byCategory.NA_SNACKS.netSalesCents).toBe(500);
  });

  it("buckets gift cards to OTHER", () => {
    const o = order("o1", [
      line({ uid: "a", item_type: "GIFT_CARD", gross_sales_money: { amount: 5000, currency: "USD" } }),
    ]);
    const { byCategory } = buildTaproomModelReport([o], items, []);
    expect(byCategory.OTHER.grossSalesCents).toBe(5000);
  });

  it("ignores line items with no recognized category", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "unknown-var", gross_sales_money: { amount: 9999, currency: "USD" } })]);
    const { byCategory } = buildTaproomModelReport([o], items, []);
    const total = Object.values(byCategory).reduce((s, t) => s + t.grossSalesCents, 0);
    expect(total).toBe(0);
  });

  it("accumulates tips across orders", () => {
    const o1 = order("o1", [], { total_tip_money: { amount: 300, currency: "USD" } });
    const o2 = order("o2", [], { total_tip_money: { amount: 200, currency: "USD" } });
    const { totalTipsCents } = buildTaproomModelReport([o1, o2], items, []);
    expect(totalTipsCents).toBe(500);
  });

  it("initializes every category to zero for empty input", () => {
    const { byCategory, totalTipsCents } = buildTaproomModelReport([], items, []);
    expect(totalTipsCents).toBe(0);
    for (const t of Object.values(byCategory)) {
      expect(t).toEqual({ grossSalesCents: 0, discountsCents: 0, returnsCents: 0, taxCents: 0, netSalesCents: 0 });
    }
  });
});

describe("buildTaproomModelReport — kegs", () => {
  const items = [
    makeItem({ id: "k1", name: "Pale Ale (Keg)", categoryId: KEGS_CAT, variations: [{ id: "half", name: "1/2 Keg" }] }),
  ];

  it("counts keg sales under KEGS but excludes transfers", () => {
    const sale = order("o1", [line({ uid: "a", catalog_object_id: "half", gross_sales_money: { amount: 30000, currency: "USD" } })]);
    const transfer = order("o2", [
      line({ uid: "b", catalog_object_id: "half", gross_sales_money: { amount: 30000, currency: "USD" }, applied_discounts: [{ uid: "ad", discount_uid: "d1" }] }),
    ], { discounts: [{ uid: "d1", name: KEG_TRANSFER_DISCOUNT_NAME }] });
    const { byCategory } = buildTaproomModelReport([sale, transfer], items, []);
    expect(byCategory.KEGS.grossSalesCents).toBe(30000); // only the non-transfer keg
  });
});

describe("buildTaproomModelReport — cocktails dedup", () => {
  // Non-combo cocktail — must be counted once under COCKTAILS, not re-bucketed.
  const items = [
    makeItem({ id: "ck1", name: "Margarita", categoryId: COCKTAIL_CAT, variations: [{ id: "ckv", name: "Single", priceCents: 900 }] }),
  ];

  it("counts a non-combo cocktail under COCKTAILS exactly once", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "ckv", gross_sales_money: { amount: 900, currency: "USD" } })]);
    const { byCategory } = buildTaproomModelReport([o], items, []);
    expect(byCategory.COCKTAILS.grossSalesCents).toBe(900);
  });
});

describe("buildTaproomModelReport — refund attribution", () => {
  const items = [
    makeItem({ id: "d1", name: "Citra Haze", categoryId: DRAFT_CAT, variations: [{ id: "draftv", name: "Pint" }] }),
    makeItem({ id: "m1", name: "Tee Shirt", categoryId: MERCH_CAT, variations: [{ id: "merchv", name: "L" }] }),
  ];

  it("distributes a refund proportionally across an order's categories", () => {
    // Order total = 1000 (draft) + 3000 (merch) = 4000. Refund 400.
    // draft share = round(1000/4000 * 400) = 100; merch share = round(3000/4000 * 400) = 300.
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "draftv", gross_sales_money: { amount: 1000, currency: "USD" } }),
      line({ uid: "b", catalog_object_id: "merchv", gross_sales_money: { amount: 3000, currency: "USD" } }),
    ]);
    const { byCategory } = buildTaproomModelReport([o], items, [refund("o1", 400)]);
    expect(byCategory.DRAFT_BEER.returnsCents).toBe(100);
    expect(byCategory.MERCHANDISE.returnsCents).toBe(300);
    expect(byCategory.DRAFT_BEER.netSalesCents).toBe(900); // 1000 - 0 - 100
    expect(byCategory.MERCHANDISE.netSalesCents).toBe(2700); // 3000 - 0 - 300
  });

  it("skips refunds whose order is not in the fetched set", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "draftv", gross_sales_money: { amount: 1000, currency: "USD" } })]);
    const { byCategory } = buildTaproomModelReport([o], items, [refund("missing-order", 400)]);
    expect(byCategory.DRAFT_BEER.returnsCents).toBe(0);
  });

  it("skips refund when the order's sellable total is zero", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "draftv", gross_sales_money: { amount: 0, currency: "USD" } })]);
    const { byCategory } = buildTaproomModelReport([o], items, [refund("o1", 400)]);
    expect(byCategory.DRAFT_BEER.returnsCents).toBe(0);
  });

  it("excludes keg-transfer lines from the refund denominator", () => {
    const kegItems = [
      makeItem({ id: "k1", name: "Pale Ale (Keg)", categoryId: KEGS_CAT, variations: [{ id: "half", name: "1/2 Keg" }] }),
      ...items,
    ];
    // draft 1000 (sellable) + transfer keg 5000 (excluded). Refund 100 → all to draft.
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "draftv", gross_sales_money: { amount: 1000, currency: "USD" } }),
      line({ uid: "b", catalog_object_id: "half", gross_sales_money: { amount: 5000, currency: "USD" }, applied_discounts: [{ uid: "ad", discount_uid: "d1" }] }),
    ], { discounts: [{ uid: "d1", name: KEG_TRANSFER_DISCOUNT_NAME }] });
    const { byCategory } = buildTaproomModelReport([o], kegItems, [refund("o1", 100)]);
    expect(byCategory.DRAFT_BEER.returnsCents).toBe(100); // denominator excluded the transfer
    expect(byCategory.KEGS.returnsCents).toBe(0);
  });
});

describe("buildTaproomModelReport — returns via return orders", () => {
  const items = [
    makeItem({ id: "d1", name: "Citra Haze", categoryId: DRAFT_CAT, variations: [{ id: "draftv", name: "Pint" }] }),
    makeItem({ id: "m1", name: "Tee Shirt", categoryId: MERCH_CAT, variations: [{ id: "merchv", name: "L" }] }),
    makeItem({ id: "k1", name: "Pale Ale (Keg)", categoryId: KEGS_CAT, variations: [{ id: "half", name: "1/2 Keg" }] }),
  ];

  // The shape Square actually returns: a refund's `order_id` resolves to a
  // separate return order with NO line_items, goods under returns[].
  function returnOrder(
    id: string,
    sourceOrderId: string,
    returnLines: OrderReturnLineItem[],
    extra: Partial<OrderReturn> = {}
  ): Order {
    return order(id, [], {
      returns: [{ uid: `ret-${id}`, source_order_id: sourceOrderId, return_line_items: returnLines, ...extra }],
    });
  }

  const sale = order("sale1", [
    line({ uid: "a", catalog_object_id: "draftv", gross_sales_money: { amount: 700, currency: "USD" } }),
    line({ uid: "b", catalog_object_id: "merchv", gross_sales_money: { amount: 3000, currency: "USD" } }),
  ]);

  it("attributes each returned line to its own category, not pro-rated", () => {
    // Only the merch came back. Pro-rating would have leaked ~19% onto draft.
    const ro = returnOrder("ro1", "sale1", [
      { uid: "r1", source_line_item_uid: "b", catalog_object_id: "merchv", quantity: "1", name: "Tee Shirt", gross_return_money: { amount: 3000, currency: "USD" } },
    ]);
    const { byCategory } = buildTaproomModelReport([sale, ro], items, [refund("ro1", 3225)]);

    expect(byCategory.MERCHANDISE.returnsCents).toBe(3000);
    expect(byCategory.MERCHANDISE.netSalesCents).toBe(0); // 3000 - 0 - 3000
    expect(byCategory.DRAFT_BEER.returnsCents).toBe(0);
    expect(byCategory.DRAFT_BEER.netSalesCents).toBe(700);
  });

  it("books returns ex-tax, ignoring the tax-inclusive refund amount", () => {
    // Refund amount is 3225 (3000 + 225 tax); only the 3000 reverses gross.
    const ro = returnOrder("ro1", "sale1", [
      { uid: "r1", source_line_item_uid: "b", catalog_object_id: "merchv", quantity: "1", name: "Tee Shirt", gross_return_money: { amount: 3000, currency: "USD" }, total_tax_money: { amount: 225, currency: "USD" } },
    ]);
    const { byCategory } = buildTaproomModelReport([sale, ro], items, [refund("ro1", 3225)]);
    expect(byCategory.MERCHANDISE.returnsCents).toBe(3000);
  });

  it("books a discounted return net of its discount, so net sales lands at zero", () => {
    const discountedSale = order("sale2", [
      line({ uid: "a", catalog_object_id: "draftv", gross_sales_money: { amount: 1000, currency: "USD" }, total_discount_money: { amount: 200, currency: "USD" } }),
    ]);
    const ro = returnOrder("ro2", "sale2", [
      { uid: "r1", source_line_item_uid: "a", catalog_object_id: "draftv", quantity: "1", name: "Citra Haze", gross_return_money: { amount: 1000, currency: "USD" }, total_discount_money: { amount: 200, currency: "USD" } },
    ]);
    const { byCategory } = buildTaproomModelReport([discountedSale, ro], items, [refund("ro2", 800)]);

    expect(byCategory.DRAFT_BEER.returnsCents).toBe(800);
    expect(byCategory.DRAFT_BEER.netSalesCents).toBe(0); // 1000 - 200 - 800
  });

  it("ignores tip-only refunds, which carry no returned goods", () => {
    // Square puts these under returns[].return_tips — no return_line_items.
    const ro = order("ro3", [], { returns: [{ uid: "ret", source_order_id: "sale1" }] });
    const { byCategory } = buildTaproomModelReport([sale, ro], items, [refund("ro3", 10000)]);

    expect(byCategory.DRAFT_BEER.returnsCents).toBe(0);
    expect(byCategory.MERCHANDISE.returnsCents).toBe(0);
  });

  it("categorizes a returned keg even when the source order is outside the window", () => {
    // Return lines are self-contained, so no source order is needed.
    const ro = returnOrder("ro4", "sale-from-last-month", [
      { uid: "r1", source_line_item_uid: "x", catalog_object_id: "half", quantity: "1", name: "Pale Ale (Keg)", gross_return_money: { amount: 14900, currency: "USD" } },
    ]);
    const { byCategory } = buildTaproomModelReport([ro], items, [refund("ro4", 15980)]);
    expect(byCategory.KEGS.returnsCents).toBe(14900);
  });

  it("counts a return order once even if two refunds resolve to it", () => {
    const ro = returnOrder("ro5", "sale1", [
      { uid: "r1", source_line_item_uid: "b", catalog_object_id: "merchv", quantity: "1", name: "Tee Shirt", gross_return_money: { amount: 3000, currency: "USD" } },
    ]);
    const { byCategory } = buildTaproomModelReport([sale, ro], items, [refund("ro5", 1500), { ...refund("ro5", 1500), id: "r-second" }]);
    expect(byCategory.MERCHANDISE.returnsCents).toBe(3000);
  });
});

// The Sales Pulse category drill-down renders these rows underneath the totals
// they explain. If they ever stop summing to the total, the UI shows a figure
// that its own detail contradicts — so this reconciliation is the invariant the
// feature rests on, not a nice-to-have.
describe("buildTaproomModelReport — contributions reconcile to totals", () => {
  const items = [
    makeItem({ id: "d1", name: "Citra Haze", categoryId: DRAFT_CAT, variations: [{ id: "draftv", name: "Pint" }] }),
    makeItem({ id: "m1", name: "Tee Shirt", categoryId: MERCH_CAT, variations: [{ id: "merchv", name: "L" }] }),
    makeItem({ id: "k1", name: "Pale Ale (Keg)", categoryId: KEGS_CAT, variations: [{ id: "half", name: "1/2 Keg" }] }),
    makeItem({ id: "c1", name: "Old Fashioned", categoryId: COCKTAIL_CAT, variations: [{ id: "ofv", name: "Single" }] }),
  ];

  function expectTie(result: ReturnType<typeof buildTaproomModelReport>) {
    for (const [catId, totals] of Object.entries(result.byCategory)) {
      const rows = result.contributions.filter((c) => c.categoryId === catId);
      const sum = (pick: (c: (typeof rows)[number]) => number) => rows.reduce((s, c) => s + pick(c), 0);

      expect(sum((c) => c.grossSalesCents), `${catId} gross`).toBe(totals.grossSalesCents);
      expect(sum((c) => c.discountsCents),  `${catId} discounts`).toBe(totals.discountsCents);
      expect(sum((c) => c.returnsCents),    `${catId} returns`).toBe(totals.returnsCents);
      expect(sum((c) => c.taxCents),        `${catId} tax`).toBe(totals.taxCents);
    }
  }

  it("ties for plain line items, kegs and cocktails together", () => {
    const kegSale = order("k-o1", [
      line({ uid: "k", catalog_object_id: "half", name: "Pale Ale (Keg)", variation_name: "1/2 Keg", gross_sales_money: { amount: 14900, currency: "USD" } }),
    ]);
    const mixed = order("o1", [
      line({ uid: "a", catalog_object_id: "draftv", gross_sales_money: { amount: 700, currency: "USD" }, total_tax_money: { amount: 50, currency: "USD" } }),
      line({ uid: "b", catalog_object_id: "merchv", gross_sales_money: { amount: 3000, currency: "USD" }, total_discount_money: { amount: 300, currency: "USD" } }),
      line({ uid: "c", catalog_object_id: "ofv", gross_sales_money: { amount: 1200, currency: "USD" } }),
    ]);
    expectTie(buildTaproomModelReport([kegSale, mixed], items, []));
  });

  it("ties when returns come back through a return order", () => {
    const sale = order("sale1", [
      line({ uid: "a", catalog_object_id: "draftv", gross_sales_money: { amount: 700, currency: "USD" } }),
      line({ uid: "b", catalog_object_id: "merchv", gross_sales_money: { amount: 3000, currency: "USD" } }),
    ]);
    const ro = order("ro1", [], {
      returns: [{
        uid: "ret", source_order_id: "sale1",
        return_line_items: [
          { uid: "r1", source_line_item_uid: "b", catalog_object_id: "merchv", quantity: "1", name: "Tee Shirt", gross_return_money: { amount: 3000, currency: "USD" } },
        ],
      }],
    });
    expectTie(buildTaproomModelReport([sale, ro], items, [refund("ro1", 3225)]));
  });

  it("ties when a refund is pro-rated, and flags those rows as estimates", () => {
    // Refund points straight at the sale order — no per-line detail to read.
    const sale = order("o1", [
      line({ uid: "a", catalog_object_id: "draftv", gross_sales_money: { amount: 1000, currency: "USD" } }),
      line({ uid: "b", catalog_object_id: "merchv", gross_sales_money: { amount: 1000, currency: "USD" } }),
    ]);
    const result = buildTaproomModelReport([sale], items, [refund("o1", 400)]);
    expectTie(result);

    const returnRows = result.contributions.filter((c) => c.kind === "return");
    expect(returnRows.length).toBe(2);
    expect(returnRows.every((c) => c.prorated)).toBe(true);
  });

  it("carries the discount name so a drill-down can say which discount applied", () => {
    const discounted = order("o1", [
      line({
        uid: "a", catalog_object_id: "draftv", name: "Citra Haze", variation_name: "Pint",
        gross_sales_money: { amount: 700, currency: "USD" },
        total_discount_money: { amount: 200, currency: "USD" },
        applied_discounts: [{ uid: "ad1", discount_uid: "d1" }],
      }),
    ], { discounts: [{ uid: "d1", name: "Industry Night", scope: "LINE_ITEM" }] });

    const { contributions } = buildTaproomModelReport([discounted], items, []);
    const row = contributions.find((c) => c.categoryId === "DRAFT_BEER");
    expect(row?.discountNames).toEqual(["Industry Night"]);
    expect(row?.discountsCents).toBe(200);
    expect(row?.itemName).toBe("Citra Haze");
  });
});
