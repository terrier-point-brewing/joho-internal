import { describe, it, expect, vi } from "vitest";

// syncSquareOrders reaches the catalog to build the canonical invoice-line
// indexes. Nothing in these tests depends on a real catalog item, so an empty
// one keeps the sync entirely in-memory.
vi.mock("@/lib/square/catalog", () => ({ fetchCatalogItems: async () => [] }));

import {
  classifyOrderForSync,
  buildCoaResolvers,
  buildInvoiceLookup,
  buildOrderPayload,
  buildPosLineItems,
  buildLineItemTaxRows,
  syncSquareOrders,
  type CatalogCoaMapping,
} from "./syncPosTransactions";
import { financeSyncDb, type Row } from "./__fixtures__/financeSyncDb";
import type { Order } from "@/types/square";

const order: Order = {
  id: "ORDER_1",
  location_id: "LOC_1",
  state: "COMPLETED",
  created_at: "2026-07-01T10:00:00Z",
  updated_at: "2026-07-01T10:05:00Z",
  closed_at: "2026-07-01T10:06:00Z",
  customer_id: "CUST_1",
  total_money: { amount: 1200, currency: "USD" },
  total_tax_money: { amount: 100, currency: "USD" },
  total_tip_money: { amount: 200, currency: "USD" },
  total_discount_money: { amount: 50, currency: "USD" },
  line_items: [
    {
      uid: "LI_1",
      catalog_object_id: "VAR_A",
      quantity: "2",
      name: "Hazy IPA",
      variation_name: "Pint",
      base_price_money: { amount: 700, currency: "USD" },
      gross_sales_money: { amount: 1400, currency: "USD" },
      total_discount_money: { amount: 50, currency: "USD" },
      total_tax_money: { amount: 100, currency: "USD" },
      // Prod identity: line total_money = gross - discount + tax (1400-50+100).
      // Verified against square_orders.raw_data for both POS and invoice orders.
      total_money: { amount: 1450, currency: "USD" },
    },
  ],
};

describe("classifyOrderForSync", () => {
  // Something on it and money attached — otherwise the empty-shell rule fires
  // first and every case below reads "skip" for the wrong reason.
  const sale = {
    line_items: [{ uid: "li1", name: "Pint", quantity: "1" }],
    total_money: { amount: 700, currency: "USD" },
  };

  it("upserts COMPLETED, cancels CANCELED, skips the rest", () => {
    expect(classifyOrderForSync({ ...sale, state: "COMPLETED" })).toBe("upsert");
    expect(classifyOrderForSync({ ...sale, state: "CANCELED" })).toBe("cancel");
    expect(classifyOrderForSync({ ...sale, state: "OPEN" })).toBe("skip");
    expect(classifyOrderForSync({ ...sale, state: "DRAFT" })).toBe("skip");
  });

  it("skips return orders, which arrive COMPLETED but are refunds, not sales", () => {
    // Square's return order: COMPLETED, no line_items, no total_money.
    expect(
      classifyOrderForSync({ state: "COMPLETED", returns: [{ source_order_id: "SALE_1" }] }),
    ).toBe("skip");
  });

  it("treats an empty returns array as a normal sale", () => {
    expect(classifyOrderForSync({ ...sale, state: "COMPLETED", returns: [] })).toBe("upsert");
  });

  // Blank $0 rows in the Orders ledger: a cash-drawer open, a ticket started
  // and abandoned, a tab emptied before it was closed.
  it("skips empty shell orders in either state", () => {
    const noSale = {
      state: "COMPLETED",
      total_money: { amount: 0, currency: "USD" },
      tenders: [{ type: "NO_SALE" }],
    };
    expect(classifyOrderForSync(noSale)).toBe("skip");
    expect(classifyOrderForSync({ state: "CANCELED" })).toBe("skip");
  });

  // The guard that keeps the empty-shell rule from swallowing a real sale:
  // Square keeps both line_items and total_money on an order it cancels, so a
  // canceled sale still routes to "cancel" and gets actively withdrawn.
  it("still cancels a real sale that was canceled", () => {
    expect(classifyOrderForSync({ ...sale, state: "CANCELED" })).toBe("cancel");
  });
});

describe("buildCoaResolvers", () => {
  const mappings: CatalogCoaMapping[] = [
    { square_variation_id: "VAR_A", chart_of_accounts_id: "COA_DEF", chart_of_accounts_id_pos: "COA_POS", chart_of_accounts_id_invoice: null },
    { square_variation_id: "VAR_B", chart_of_accounts_id: "COA_DEF_B", chart_of_accounts_id_pos: null, chart_of_accounts_id_invoice: "COA_INV_B" },
    { square_variation_id: null, chart_of_accounts_id: "IGNORED", chart_of_accounts_id_pos: null, chart_of_accounts_id_invoice: null },
  ];

  it("prefers the source-specific override, then the default, else null", () => {
    const { getPosCoA, getInvoiceCoA } = buildCoaResolvers(mappings);
    // POS override present for VAR_A
    expect(getPosCoA("VAR_A")).toBe("COA_POS");
    // no POS override for VAR_B → default
    expect(getPosCoA("VAR_B")).toBe("COA_DEF_B");
    // invoice override for VAR_B
    expect(getInvoiceCoA("VAR_B")).toBe("COA_INV_B");
    // no invoice override for VAR_A → default
    expect(getInvoiceCoA("VAR_A")).toBe("COA_DEF");
    // unknown variation → null
    expect(getPosCoA("VAR_Z")).toBeNull();
    expect(getInvoiceCoA("VAR_Z")).toBeNull();
  });

  it("skips rows with no variation id", () => {
    const { getPosCoA } = buildCoaResolvers(mappings);
    expect(getPosCoA("")).toBeNull();
  });
});

describe("buildInvoiceLookup", () => {
  it("maps square_order_id → invoice db id, ignoring rows without one", () => {
    const map = buildInvoiceLookup([
      { id: "INV_1", raw_data: { square_order_id: "ORDER_1" } },
      { id: "INV_2", raw_data: {} },
      { id: "INV_3", raw_data: null },
    ]);
    expect(map.get("ORDER_1")).toBe("INV_1");
    expect(map.size).toBe(1);
  });
});

describe("buildOrderPayload", () => {
  it("maps money fields to cents and prefers closed_at for the transaction date", () => {
    const p = buildOrderPayload(order, null);
    expect(p).toMatchObject({
      square_order_id: "ORDER_1",
      location_id: "LOC_1",
      transaction_date: "2026-07-01T10:06:00Z",
      customer_id: "CUST_1",
      customer_name: null,
      total_cents: 1200,
      tax_cents: 100,
      tip_cents: 200,
      discount_cents: 50,
      status: "COMPLETED",
      invoice_id: null,
    });
  });

  it("passes through the invoice id when invoice-backed", () => {
    expect(buildOrderPayload(order, "INV_9").invoice_id).toBe("INV_9");
  });

  it("falls back to updated_at then created_at when closed_at is missing", () => {
    const noClose = { ...order, closed_at: undefined };
    expect(buildOrderPayload(noClose, null).transaction_date).toBe("2026-07-01T10:05:00Z");
    const created = { ...order, closed_at: undefined, updated_at: undefined };
    expect(buildOrderPayload(created, null).transaction_date).toBe("2026-07-01T10:00:00Z");
  });
});

describe("buildPosLineItems", () => {
  it("builds POS rows with resolved CoA and numeric quantity", () => {
    const items = buildPosLineItems("DBID_1", order, (v) => (v === "VAR_A" ? "COA_POS" : null));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      order_id: "DBID_1",
      square_line_item_uid: "LI_1",
      square_variation_id: "VAR_A",
      name: "Hazy IPA",
      variation_name: "Pint",
      quantity: 2,
      base_price_cents: 700,
      gross_sales_cents: 1400,
      discount_cents: 50,
      net_sales_cents: 1350,
      tax_cents: 100,
      chart_of_accounts_id: "COA_POS",
    });
  });

  it("leaves chart_of_accounts_id null for uncatalogued line items", () => {
    const noVar = { ...order, line_items: [{ uid: "LI_2", quantity: "1", name: "Custom" }] };
    const items = buildPosLineItems("DBID_1", noVar, () => "SHOULD_NOT_BE_USED");
    expect(items[0].chart_of_accounts_id).toBeNull();
  });

  it("excludes tax from net_sales_cents (sales tax is a liability, not revenue)", () => {
    const items = buildPosLineItems("DBID_1", order, () => null);
    // gross 1400 - discount 50 = 1350; the line's 100c of tax must NOT be here.
    expect(items[0].net_sales_cents).toBe(1350);
    expect(items[0].tax_cents).toBe(100);
    expect(items[0].net_sales_cents + items[0].tax_cents).toBe(
      order.line_items![0].total_money!.amount,
    );
  });

  // A re-sync rebuilds these rows by delete-then-insert, so anything a human put
  // on the old row has to be carried forward explicitly or it is silently lost.
  it("keeps a prior manual mapping instead of reverting to the catalog default", () => {
    const prior = new Map([
      ["LI_1", { chart_of_accounts_id: "COA_HAND_SET", gl_manually_set: true, notes: "reclassed for the taproom split" }],
    ]);
    const items = buildPosLineItems("DBID_1", order, () => "COA_CATALOG", prior);
    expect(items[0].chart_of_accounts_id).toBe("COA_HAND_SET");
    expect(items[0].notes).toBe("reclassed for the taproom split");
    // The flag has to ride along with the id — preserving the account but
    // dropping the flag would silently reclassify it as rule-derived.
    expect(items[0].gl_manually_set).toBe(true);
  });

  it("falls back to the catalog mapping for lines with no prior state", () => {
    const prior = new Map([
      ["SOME_OTHER_UID", { chart_of_accounts_id: "COA_HAND_SET", gl_manually_set: true, notes: null }],
    ]);
    const items = buildPosLineItems("DBID_1", order, () => "COA_CATALOG", prior);
    expect(items[0].chart_of_accounts_id).toBe("COA_CATALOG");
    expect(items[0].gl_manually_set).toBe(false);
    expect(items[0].notes).toBeNull();
  });

  it("carries a prior note even when the mapping itself was never set", () => {
    const prior = new Map([
      ["LI_1", { chart_of_accounts_id: null, gl_manually_set: false, notes: "check with Will" }],
    ]);
    const items = buildPosLineItems("DBID_1", order, () => "COA_CATALOG", prior);
    // Null prior mapping must not shadow the catalog default...
    expect(items[0].chart_of_accounts_id).toBe("COA_CATALOG");
    // ...but the note still survives the rebuild.
    expect(items[0].notes).toBe("check with Will");
    expect(items[0].gl_manually_set).toBe(false);
  });

  // The catalog mapping is a rule. Only the Orders grid PATCH promotes a line to
  // "manual", so a freshly synced row must never claim to be one.
  it("never marks a rule-derived mapping as manually set", () => {
    const items = buildPosLineItems("DBID_1", order, () => "COA_CATALOG");
    expect(items[0].chart_of_accounts_id).toBe("COA_CATALOG");
    expect(items[0].gl_manually_set).toBe(false);
  });

  it("behaves exactly as before when no prior state is passed", () => {
    const items = buildPosLineItems("DBID_1", order, () => "COA_CATALOG");
    expect(items[0].chart_of_accounts_id).toBe("COA_CATALOG");
    expect(items[0].notes).toBeNull();
  });
});

describe("buildLineItemTaxRows", () => {
  const taxOrder: Order = {
    ...order,
    taxes: [{ uid: "t1", catalog_object_id: "TAX_GEN", name: "General Sales Tax", percentage: "7.25" }],
    line_items: [
      {
        ...order.line_items![0],
        uid: "LI_1",
        applied_taxes: [{ uid: "at1", tax_uid: "t1", applied_money: { amount: 725, currency: "USD" } }],
      },
    ],
  };

  it("maps applied_taxes to catalog tax ids", () => {
    const rows = buildLineItemTaxRows(taxOrder, new Map([["LI_1", "DBID_LI_1"]]));
    expect(rows).toEqual([
      { line_item_id: "DBID_LI_1", square_tax_id: "TAX_GEN", tax_name: "General Sales Tax", tax_pct: 7.25, amount_cents: 725 },
    ]);
  });

  it("produces one row per applied tax on a line", () => {
    const twoTaxOrder: Order = {
      ...taxOrder,
      taxes: [
        { uid: "t1", catalog_object_id: "TAX_GEN", name: "General Sales Tax", percentage: "7.25" },
        { uid: "t2", catalog_object_id: "TAX_LOCAL", name: "Local Tax", percentage: "1.0" },
      ],
      line_items: [
        {
          ...order.line_items![0],
          uid: "LI_1",
          applied_taxes: [
            { uid: "at1", tax_uid: "t1", applied_money: { amount: 725, currency: "USD" } },
            { uid: "at2", tax_uid: "t2", applied_money: { amount: 100, currency: "USD" } },
          ],
        },
      ],
    };
    const rows = buildLineItemTaxRows(twoTaxOrder, new Map([["LI_1", "DBID_LI_1"]]));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      { line_item_id: "DBID_LI_1", square_tax_id: "TAX_GEN", tax_name: "General Sales Tax", tax_pct: 7.25, amount_cents: 725 },
      { line_item_id: "DBID_LI_1", square_tax_id: "TAX_LOCAL", tax_name: "Local Tax", tax_pct: 1, amount_cents: 100 },
    ]);
  });

  it("produces zero rows for a line with no applied taxes", () => {
    const noTaxOrder: Order = { ...taxOrder, line_items: [{ ...order.line_items![0], uid: "LI_1", applied_taxes: undefined }] };
    const rows = buildLineItemTaxRows(noTaxOrder, new Map([["LI_1", "DBID_LI_1"]]));
    expect(rows).toEqual([]);
  });
});

/**
 * The invoice half of syncSquareOrders, end to end against a stub that
 * remembers.
 *
 * This used to be a pure-builder test, and that is exactly why the defect it
 * now pins went unseen: the damage lived in the relationship between a builder
 * that numbered invoice lines from 1 and the writer that keys them from 0, not
 * inside either one. So these run the real function and assert on the rows that
 * end up stored.
 */
describe("syncSquareOrders — invoice-backed orders", () => {
  const INVOICE_ORDER_SEED = {
    invoices: [{ id: "INV_1", raw_data: { square_order_id: "ORDER_1" } }],
    square_catalog_variations: [
      {
        square_variation_id: "VAR_A",
        chart_of_accounts_id: "COA_CATALOGUE",
        chart_of_accounts_id_pos: null,
        chart_of_accounts_id_invoice: null,
      },
    ],
  };

  function db(existingLines: Row[] = []) {
    return financeSyncDb({ ...INVOICE_ORDER_SEED, invoice_line_items: existingLines });
  }

  const lines = (d: ReturnType<typeof db>) =>
    d.rows("invoice_line_items").sort((a, b) => (a.sort_order as number) - (b.sort_order as number));

  /** A stored line as the canonical writer leaves it, for seeding a re-sync. */
  const storedLine = (over: Row = {}): Row => ({
    invoice_id: "INV_1",
    sort_order: 0,
    description: "Hazy IPA — Pint",
    square_line_item_uid: "LI_1",
    chart_of_accounts_id: null,
    ...over,
  });

  it("numbers lines from zero, the same way every other invoice writer does", async () => {
    const d = db();

    await syncSquareOrders(d.client, [order]);

    expect(lines(d).map((r) => r.sort_order)).toEqual([0]);
  });

  it("keeps an account somebody set by hand, instead of reverting to the catalogue", async () => {
    const d = db([storedLine({ chart_of_accounts_id: "COA_CHOSEN_BY_HAND" })]);

    await syncSquareOrders(d.client, [order]);

    expect(lines(d).map((r) => r.chart_of_accounts_id)).toEqual(["COA_CHOSEN_BY_HAND"]);
  });

  // The damaging case: before this fix a hand-coded line on a product the
  // catalogue does not map came back empty, not merely reclassified.
  it("keeps a hand-set account on a line the catalogue does not map", async () => {
    const uncatalogued: Order = {
      ...order,
      line_items: [{ uid: "LI_1", quantity: "1", name: "Custom Build", gross_sales_money: { amount: 5000, currency: "USD" } }],
    };
    const d = db([storedLine({ description: "Custom Build", chart_of_accounts_id: "COA_CHOSEN_BY_HAND" })]);

    await syncSquareOrders(d.client, [uncatalogued]);

    expect(lines(d).map((r) => r.chart_of_accounts_id)).toEqual(["COA_CHOSEN_BY_HAND"]);
  });

  it("still applies the catalogue to a line nobody has touched", async () => {
    const d = db();

    await syncSquareOrders(d.client, [order]);

    expect(lines(d)[0].chart_of_accounts_id).toBe("COA_CATALOGUE");
  });

  it("writes the money columns tax-free, exactly as the canonical writer does", async () => {
    const d = db();

    await syncSquareOrders(d.client, [order]);

    // Square's line total_money is 1450 (tax-inclusive); revenue is 1400 - 50.
    expect(lines(d)[0]).toMatchObject({
      invoice_id: "INV_1",
      quantity: 2,
      unit_price_cents: 700,
      gross_sales_cents: 1400,
      discount_cents: 50,
      net_sales_cents: 1350,
      total_cents: 1350,
      tax_cents: 100,
      square_catalog_variation_id: "VAR_A",
      square_line_item_uid: "LI_1",
    });
  });

  // Columns the old builder never wrote at all, so a re-synced invoice lost its
  // categories until the nightly canonical sync put them back.
  it("writes the category and catalogue name the old builder left empty", async () => {
    const d = db();

    await syncSquareOrders(d.client, [order]);

    expect(lines(d)[0]).toMatchObject({ category: "other", line_item_name: "Hazy IPA", variation_name: "Pint" });
  });

  it("drops a carve-out excise line and renumbers the survivors contiguously", async () => {
    const withCarveOut: Order = {
      ...order,
      discounts: [{ uid: "d1", name: "Excise carve out", scope: "LINE_ITEM", applied_money: { amount: 525, currency: "USD" } }],
      line_items: [
        { uid: "a", quantity: "1", name: "Packaging Fee", gross_sales_money: { amount: 1200, currency: "USD" } },
        { uid: "b", quantity: "1", name: "Barrel Excise Tax", gross_sales_money: { amount: 525, currency: "USD" } },
        { uid: "c", quantity: "1", name: "Delivery Fee", gross_sales_money: { amount: 3000, currency: "USD" } },
      ],
    };
    const d = db();

    await syncSquareOrders(d.client, [withCarveOut]);

    expect(lines(d).map((r) => [r.sort_order, r.line_item_name])).toEqual([[0, "Packaging Fee"], [1, "Delivery Fee"]]);
  });

  it("rebuilds the invoice's tax rows, which this path used to leave to somebody else", async () => {
    const taxed: Order = {
      ...order,
      taxes: [{ uid: "t1", catalog_object_id: "TAX_GEN", name: "General Sales Tax", percentage: "7.25" }],
      line_items: [{ ...order.line_items![0], applied_taxes: [{ uid: "at1", tax_uid: "t1", applied_money: { amount: 100, currency: "USD" } }] }],
    };
    const d = db();

    await syncSquareOrders(d.client, [taxed]);

    expect(d.rows("invoice_line_item_taxes")).toEqual([
      { id: expect.any(String), line_item_id: lines(d)[0].id, square_tax_id: "TAX_GEN", tax_name: "General Sales Tax", tax_pct: 7.25, amount_cents: 100 },
    ]);
  });

  // The order-line path's fail-safe, now on the invoice side too: if we cannot
  // read what is there, we do not get to replace it.
  it("leaves the invoice completely alone when its prior lines cannot be read", async () => {
    const d = db([storedLine({ chart_of_accounts_id: "COA_CHOSEN_BY_HAND" })]);
    d.failSelectsOn("invoice_line_items");

    const result = await syncSquareOrders(d.client, [order]);

    expect(lines(d).map((r) => r.chart_of_accounts_id)).toEqual(["COA_CHOSEN_BY_HAND"]);
    expect(result.synced).toBe(0);
    expect(result.errors?.some((e) => e.includes("Prior invoice line state"))).toBe(true);
  });

  it("withdraws the lines of an invoice whose order was canceled", async () => {
    const d = db([storedLine({ chart_of_accounts_id: "COA_CHOSEN_BY_HAND" })]);

    const result = await syncSquareOrders(d.client, [{ ...order, state: "CANCELED" }]);

    expect(lines(d)).toEqual([]);
    expect(result.canceled).toBe(1);
  });

  it("converges: a second run over the same order changes nothing", async () => {
    const d = db();
    await syncSquareOrders(d.client, [order]);
    const first = lines(d);

    await syncSquareOrders(d.client, [order]);

    expect(lines(d)).toEqual(first);
  });
});
