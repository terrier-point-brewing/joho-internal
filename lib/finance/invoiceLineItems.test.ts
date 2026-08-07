import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildInvoiceLineItemRows,
  invoiceHeaderTotalsFromOrder,
  persistInvoiceLineItems,
  type CanonicalLineItemRow,
  type LineItemIndexes,
} from "./invoiceLineItems";
import type { Order } from "@/types/square";

/**
 * The label a row renders as. Composed, never stored — these assertions used to
 * read a `description` column that held this exact concatenation until it was
 * dropped for going stale against renamed catalog items.
 */
const label = (r: { line_item_name: string | null; variation_name: string | null }) =>
  r.line_item_name && r.variation_name ? `${r.line_item_name} — ${r.variation_name}` : r.line_item_name;

const emptyIndexes: LineItemIndexes = {
  kegIndex: new Map(),
  canVariationOz: new Map(),
  variationById: new Map(),
  itemNameByVariationId: new Map([["VAR1", "Barrel Excise Tax"]]),
};

function orderWith(lineItems: Order["line_items"], discounts?: Order["discounts"]): Order {
  return {
    id: "O1", location_id: "L", state: "OPEN", created_at: "2026-07-11T00:00:00Z",
    line_items: lineItems, discounts,
    total_money: { amount: 0, currency: "USD" },
  } as Order;
}

describe("buildInvoiceLineItemRows", () => {
  it("splits catalog identity (col1) from note (col2) and computes net = gross - discount", () => {
    const order = orderWith([
      {
        uid: "u1", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax",
        variation_name: "Regular", note: "TTB (1.50 bbls)",
        base_price_money: { amount: 525, currency: "USD" },
        gross_sales_money: { amount: 525, currency: "USD" },
        total_discount_money: { amount: 0, currency: "USD" },
        total_tax_money: { amount: 0, currency: "USD" },
        total_money: { amount: 525, currency: "USD" },
      },
    ]);
    const [row] = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    expect(row.line_item_name).toBe("Barrel Excise Tax");
    expect(row.variation_name).toBe("Regular");
    expect(row.note).toBe("TTB (1.50 bbls)");
    expect(row.square_catalog_variation_id).toBe("VAR1");
    expect(row.gross_sales_cents).toBe(525);
    expect(row.net_sales_cents).toBe(525);
    expect(row.total_cents).toBe(525);
  });

  it("records a line-scoped discount and nets it out of total", () => {
    const order = orderWith([
      {
        uid: "u1", catalog_object_id: "VARX", quantity: "40", name: "Vienna Lager (Keg)",
        variation_name: "1/6 Keg",
        base_price_money: { amount: 7900, currency: "USD" },
        gross_sales_money: { amount: 316000, currency: "USD" },
        total_discount_money: { amount: 94800, currency: "USD" },
        total_tax_money: { amount: 0, currency: "USD" },
        total_money: { amount: 221200, currency: "USD" },
      },
    ]);
    const [row] = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    expect(row.discount_cents).toBe(94800);
    expect(row.net_sales_cents).toBe(221200);
    expect(row.total_cents).toBe(221200);
  });

  describe("invoice-level (ORDER-scope) discounts", () => {
    // Square smears an ORDER-scope discount pro-rata into every line's
    // total_discount_money. Mirrors invoice 000048: $270 off, allocated across
    // packaging fees, a pass-through excise line, and services.
    const smearedOrder = () => {
      const order = orderWith(
        [
          {
            uid: "u1", catalog_object_id: "VARP", quantity: "10", name: "Packaging Fee",
            variation_name: "1/2 Keg",
            base_price_money: { amount: 4500, currency: "USD" },
            gross_sales_money: { amount: 45000, currency: "USD" },
            // Square's allocated slice — must NOT land on the line.
            total_discount_money: { amount: 9161, currency: "USD" },
            applied_discounts: [{ uid: "ad1", discount_uid: "d-order", applied_money: { amount: 9161, currency: "USD" } }],
            total_money: { amount: 35839, currency: "USD" },
          },
          {
            uid: "u2", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax",
            variation_name: "Regular",
            base_price_money: { amount: 19125, currency: "USD" },
            gross_sales_money: { amount: 19125, currency: "USD" },
            total_discount_money: { amount: 3894, currency: "USD" },
            applied_discounts: [{ uid: "ad2", discount_uid: "d-order", applied_money: { amount: 3894, currency: "USD" } }],
            total_money: { amount: 15231, currency: "USD" },
          },
        ],
        [{ uid: "d-order", name: "Custom Discount", scope: "ORDER", applied_money: { amount: 27000, currency: "USD" } }],
      );
      return order;
    };

    it("leaves real lines at gross instead of absorbing Square's pro-rata slice", () => {
      const rows = buildInvoiceLineItemRows("INV1", smearedOrder(), emptyIndexes, new Map());
      const [packaging, excise] = rows;
      expect(packaging.discount_cents).toBe(0);
      expect(packaging.total_cents).toBe(45000);
      // The whole point: a pass-through tax we remit in full is never discounted.
      expect(excise.discount_cents).toBe(0);
      expect(excise.total_cents).toBe(19125);
    });

    it("writes the discount as its own negative, unmapped trailing line", () => {
      const rows = buildInvoiceLineItemRows("INV1", smearedOrder(), emptyIndexes, new Map());
      expect(rows).toHaveLength(3);
      const discount = rows[2];
      expect(discount.category).toBe("discount");
      expect(discount.line_item_name).toBe("Custom Discount");
      expect(discount.total_cents).toBe(-27000);
      expect(discount.net_sales_cents).toBe(-27000);
      // Unmapped on purpose — a human assigns the contra-revenue account.
      expect(discount.chart_of_accounts_id).toBeNull();
      expect(discount.square_line_item_uid).toBeNull();
    });

    it("keeps the lines summing to the invoice total, so Financials still ties", () => {
      const order = smearedOrder();
      order.total_money = { amount: 37125, currency: "USD" };
      const rows = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
      const lineSum = rows.reduce((s, r) => s + r.total_cents, 0);
      const totals = invoiceHeaderTotalsFromOrder(order);
      expect(lineSum).toBe(totals.total_cents);
      // And the discount line equals the header's discount figure exactly.
      expect(rows[2].total_cents).toBe(-totals.discount_cents);
    });

    it("preserves a hand-mapped account on the discount line across a re-sync", () => {
      const existing = new Map([[2, { chart_of_accounts_id: "coa-4900" }]]);
      const rows = buildInvoiceLineItemRows("INV1", smearedOrder(), emptyIndexes, existing);
      expect(rows[2].chart_of_accounts_id).toBe("coa-4900");
    });

    it("still nets LINE_ITEM-scope discounts out of their own line", () => {
      const order = orderWith(
        [
          {
            uid: "u1", catalog_object_id: "VARX", quantity: "1", name: "Keg",
            gross_sales_money: { amount: 10000, currency: "USD" },
            total_discount_money: { amount: 3500, currency: "USD" },
            applied_discounts: [
              { uid: "a1", discount_uid: "d-line", applied_money: { amount: 1500, currency: "USD" } },
              { uid: "a2", discount_uid: "d-order", applied_money: { amount: 2000, currency: "USD" } },
            ],
            total_money: { amount: 6500, currency: "USD" },
          },
        ],
        [
          { uid: "d-line", name: "Bulk Discount", scope: "LINE_ITEM", applied_money: { amount: 1500, currency: "USD" } },
          { uid: "d-order", name: "Custom Discount", scope: "ORDER", applied_money: { amount: 2000, currency: "USD" } },
        ],
      );
      const rows = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
      expect(rows[0].discount_cents).toBe(1500);
      expect(rows[0].total_cents).toBe(8500);
      expect(rows[1].total_cents).toBe(-2000);
    });

    it("adds no discount line, and changes nothing, when there is no order-level discount", () => {
      const order = orderWith([
        {
          uid: "u1", catalog_object_id: "VARX", quantity: "1", name: "Keg",
          gross_sales_money: { amount: 10000, currency: "USD" },
          total_discount_money: { amount: 1500, currency: "USD" },
          total_tax_money: { amount: 0, currency: "USD" },
          total_money: { amount: 8500, currency: "USD" },
        },
      ]);
      const rows = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
      expect(rows).toHaveLength(1);
      // No applied_discounts on this line at all — the legacy path still works.
      expect(rows[0].discount_cents).toBe(1500);
      expect(rows[0].total_cents).toBe(8500);
    });
  });

  it("keeps two same-variation lines distinct via note; both map to the same variation id", () => {
    const order = orderWith([
      { uid: "a", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", note: "TTB (1.50 bbls)", gross_sales_money: { amount: 525, currency: "USD" }, total_money: { amount: 525, currency: "USD" } },
      { uid: "b", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", note: "NC Dept of Revenue (46.50 gal)", gross_sales_money: { amount: 2883, currency: "USD" }, total_money: { amount: 2883, currency: "USD" } },
    ]);
    const rows = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    expect(rows).toHaveLength(2);
    expect(rows[0].note).not.toBe(rows[1].note);
    expect(rows[0].square_catalog_variation_id).toBe(rows[1].square_catalog_variation_id);
  });

  it("prefills COA from the variation's default chart_of_accounts_id when no invoice override", () => {
    const indexes: LineItemIndexes = {
      ...emptyIndexes,
      variationById: new Map([["VAR1", {
        chart_of_accounts_id_invoice: null,
        chart_of_accounts_id: "COA-DEFAULT",
      }]]),
    };
    const order = orderWith([
      { uid: "u1", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", gross_sales_money: { amount: 525, currency: "USD" }, total_money: { amount: 525, currency: "USD" } },
    ]);
    const [row] = buildInvoiceLineItemRows("INV1", order, indexes, new Map());
    expect(row.chart_of_accounts_id).toBe("COA-DEFAULT");
  });

  it("prefers the invoice-specific COA override over the variation default", () => {
    const indexes: LineItemIndexes = {
      ...emptyIndexes,
      variationById: new Map([["VAR1", {
        chart_of_accounts_id_invoice: "COA-INVOICE",
        chart_of_accounts_id: "COA-DEFAULT",
      }]]),
    };
    const order = orderWith([
      { uid: "u1", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", gross_sales_money: { amount: 525, currency: "USD" }, total_money: { amount: 525, currency: "USD" } },
    ]);
    const [row] = buildInvoiceLineItemRows("INV1", order, indexes, new Map());
    expect(row.chart_of_accounts_id).toBe("COA-INVOICE");
  });

  it("numbers sort_order contiguously when a carve-out excise line sits in the middle", () => {
    const order = orderWith(
      [
        { uid: "a", catalog_object_id: "VARK", quantity: "10", name: "Vienna Lager (Keg)", variation_name: "1/6 Keg", gross_sales_money: { amount: 79000, currency: "USD" }, total_money: { amount: 79000, currency: "USD" } },
        { uid: "b", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", note: "TTB (1.50 bbls)", gross_sales_money: { amount: 525, currency: "USD" }, total_money: { amount: 525, currency: "USD" } },
        { uid: "c", quantity: "1", name: "Packaging Fee", gross_sales_money: { amount: 1200, currency: "USD" }, total_money: { amount: 1200, currency: "USD" } },
      ],
      [{ uid: "d", name: "Excise carve out", scope: "LINE_ITEM", applied_money: { amount: 525, currency: "USD" } }],
    );
    const rows = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    // The middle line is dropped, so the survivors must renumber 0,1 — not 0,2.
    expect(rows.map(label)).toEqual(["Vienna Lager (Keg) — 1/6 Keg", "Packaging Fee"]);
    expect(rows.map((r) => r.sort_order)).toEqual([0, 1]);
  });

  it("aligns square_line_item_uid with sort_order across a skipped excise line", () => {
    const order = orderWith(
      [
        { uid: "u-a", quantity: "1", name: "Packaging Fee", gross_sales_money: { amount: 100, currency: "USD" }, total_money: { amount: 100, currency: "USD" } },
        // Skipped: carve-out excise line, matched on gross === 500.
        { uid: "u-excise", quantity: "1", name: "Barrel Excise Tax", gross_sales_money: { amount: 500, currency: "USD" }, total_money: { amount: 500, currency: "USD" } },
        { uid: "u-c", quantity: "1", name: "CO2 Refill", gross_sales_money: { amount: 900, currency: "USD" }, total_tax_money: { amount: 65, currency: "USD" }, total_money: { amount: 900, currency: "USD" } },
      ],
      [{ uid: "d", name: "Excise carve out", scope: "LINE_ITEM", applied_money: { amount: 500, currency: "USD" } }],
    );

    const rows = buildInvoiceLineItemRows("INV_1", order, emptyIndexes, new Map());

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sort_order: 0, square_line_item_uid: "u-a" });
    // The excise line is skipped WITHOUT advancing sort_order, so row 1 must
    // carry u-c -- not u-excise. This is the off-by-one that corrupted 60 rows.
    expect(rows[1]).toMatchObject({ sort_order: 1, square_line_item_uid: "u-c", tax_cents: 65 });
  });

  it("keys existingCoaBySort by push position, so a dropped carve-out does not shift COA onto the wrong line", () => {
    const order = orderWith(
      [
        { uid: "a", quantity: "1", name: "Packaging Fee", gross_sales_money: { amount: 1200, currency: "USD" }, total_money: { amount: 1200, currency: "USD" } },
        { uid: "b", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", gross_sales_money: { amount: 525, currency: "USD" }, total_money: { amount: 525, currency: "USD" } },
        { uid: "c", quantity: "1", name: "Delivery Fee", gross_sales_money: { amount: 3000, currency: "USD" }, total_money: { amount: 3000, currency: "USD" } },
      ],
      [{ uid: "d", name: "Excise carve out", scope: "LINE_ITEM", applied_money: { amount: 525, currency: "USD" } }],
    );
    // Mirrors what syncSquareInvoices reads back: DB sort_order values this same
    // function wrote on the previous sync, i.e. push positions 0 and 1.
    const existing = new Map([
      [0, { chart_of_accounts_id: "COA-PACKAGING" }],
      [1, { chart_of_accounts_id: "COA-DELIVERY" }],
    ]);
    const rows = buildInvoiceLineItemRows("INV1", order, emptyIndexes, existing);
    expect(rows.map(label)).toEqual(["Packaging Fee", "Delivery Fee"]);
    expect(rows.map((r) => r.chart_of_accounts_id)).toEqual(["COA-PACKAGING", "COA-DELIVERY"]);
  });

  it("preserves an existing non-null COA (fill-nulls-only)", () => {
    const order = orderWith([
      { uid: "u1", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", gross_sales_money: { amount: 525, currency: "USD" }, total_money: { amount: 525, currency: "USD" } },
    ]);
    const existing = new Map([[0, { chart_of_accounts_id: "USER-SET" }]]);
    const [row] = buildInvoiceLineItemRows("INV1", order, emptyIndexes, existing);
    expect(row.chart_of_accounts_id).toBe("USER-SET");
  });
});

/**
 * In-memory `invoice_line_items` stub covering the two calls persistInvoiceLineItems
 * makes: `.upsert(rows, { onConflict: "invoice_id,sort_order" })` and the trailing
 * cleanup `.delete().eq("invoice_id", …).gt("sort_order", n)`. Keeps the stored rows
 * so a test can assert what actually survives a persist.
 */
function invoiceLineItemsStub(seed: CanonicalLineItemRow[] = []) {
  let stored = [...seed];
  const client = {
    from: (table: string) => {
      if (table !== "invoice_line_items") throw new Error(`unexpected table ${table}`);
      return {
        upsert: (rows: CanonicalLineItemRow[]) => {
          for (const row of rows) {
            const at = stored.findIndex(
              (s) => s.invoice_id === row.invoice_id && s.sort_order === row.sort_order,
            );
            if (at >= 0) stored[at] = row;
            else stored.push(row);
          }
          return Promise.resolve({ error: null });
        },
        delete: () => {
          const filters: Array<(r: CanonicalLineItemRow) => boolean> = [];
          const chain = {
            eq: (col: string, val: unknown) => {
              filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
              return chain;
            },
            gt: (col: string, val: number) => {
              filters.push((r) => (r as unknown as Record<string, number>)[col] > val);
              return chain;
            },
            then: (resolve: (v: { error: null }) => void) => {
              stored = stored.filter((r) => !filters.every((f) => f(r)));
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, rows: () => stored };
}

describe("persistInvoiceLineItems", () => {
  it("keeps every row when an order's carve-out line is dropped mid-list", async () => {
    const order = orderWith(
      [
        { uid: "a", quantity: "1", name: "Packaging Fee", gross_sales_money: { amount: 1200, currency: "USD" }, total_money: { amount: 1200, currency: "USD" } },
        { uid: "b", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", gross_sales_money: { amount: 525, currency: "USD" }, total_money: { amount: 525, currency: "USD" } },
        { uid: "c", quantity: "1", name: "Delivery Fee", gross_sales_money: { amount: 3000, currency: "USD" }, total_money: { amount: 3000, currency: "USD" } },
      ],
      [{ uid: "d", name: "Excise carve out", scope: "LINE_ITEM", applied_money: { amount: 525, currency: "USD" } }],
    );
    const rows = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    const db = invoiceLineItemsStub();

    const { error } = await persistInvoiceLineItems(db.client, "INV1", rows);

    expect(error).toBeUndefined();
    // With a gapped sort_order ([0, 3]) the `> rows.length - 1` cleanup would delete
    // the Delivery Fee row it had just written.
    expect(db.rows().map(label)).toEqual(["Packaging Fee", "Delivery Fee"]);
  });

  it("still deletes rows left over from a longer previous sync", async () => {
    const order = orderWith([
      { uid: "a", quantity: "1", name: "Packaging Fee", gross_sales_money: { amount: 1200, currency: "USD" }, total_money: { amount: 1200, currency: "USD" } },
    ]);
    const rows = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    const stale = { ...rows[0], sort_order: 1, line_item_name: "Removed Line" };
    const db = invoiceLineItemsStub([{ ...rows[0] }, stale]);

    await persistInvoiceLineItems(db.client, "INV1", rows);

    expect(db.rows().map(label)).toEqual(["Packaging Fee"]);
  });
});

/**
 * In-memory stub covering `invoice_line_items` (upsert/delete/select-back, with
 * server-assigned ids) AND `invoice_line_item_taxes` (delete/insert) --
 * everything `persistInvoiceLineItems` touches once an `order` is passed.
 */
function invoiceLineItemsWithTaxesStub(seed: CanonicalLineItemRow[] = []) {
  let stored: (CanonicalLineItemRow & { id: string })[] = seed.map((r, i) => ({ ...r, id: `row-${i}` }));
  let taxRows: { line_item_id: string; square_tax_id: string; tax_name: string | null; tax_pct: number | null; amount_cents: number }[] = [];
  let nextId = stored.length;

  const client = {
    from: (table: string) => {
      if (table === "invoice_line_items") {
        return {
          upsert: (rows: CanonicalLineItemRow[]) => {
            for (const row of rows) {
              const at = stored.findIndex((s) => s.invoice_id === row.invoice_id && s.sort_order === row.sort_order);
              if (at >= 0) stored[at] = { ...row, id: stored[at].id };
              else stored.push({ ...row, id: `row-${nextId++}` });
            }
            return Promise.resolve({ error: null });
          },
          delete: () => {
            const filters: Array<(r: CanonicalLineItemRow) => boolean> = [];
            const chain = {
              eq: (col: string, val: unknown) => {
                filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
                return chain;
              },
              gt: (col: string, val: number) => {
                filters.push((r) => (r as unknown as Record<string, number>)[col] > val);
                return chain;
              },
              then: (resolve: (v: { error: null }) => void) => {
                stored = stored.filter((r) => !filters.every((f) => f(r)));
                return Promise.resolve({ error: null }).then(resolve);
              },
            };
            return chain;
          },
          select: () => ({
            eq: (col: string, val: unknown) =>
              Promise.resolve({
                data: stored
                  .filter((r) => (r as unknown as Record<string, unknown>)[col] === val)
                  .map((r) => ({ id: r.id, square_line_item_uid: r.square_line_item_uid })),
                error: null,
              }),
          }),
        };
      }
      if (table === "invoice_line_item_taxes") {
        return {
          delete: () => ({
            in: (_col: string, ids: string[]) => {
              taxRows = taxRows.filter((t) => !ids.includes(t.line_item_id));
              return Promise.resolve({ error: null });
            },
          }),
          insert: (rows: typeof taxRows) => {
            taxRows.push(...rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;

  return { client, rows: () => stored, taxRows: () => taxRows };
}

describe("persistInvoiceLineItems — tax-row rebuild (order passed)", () => {
  it("rebuilds invoice_line_item_taxes from the order, keyed to the read-back row ids", async () => {
    const order = orderWith([
      {
        uid: "u-a", quantity: "1", name: "CO2 Refill",
        gross_sales_money: { amount: 900, currency: "USD" },
        total_tax_money: { amount: 65, currency: "USD" },
        total_money: { amount: 965, currency: "USD" },
        applied_taxes: [{ uid: "at1", tax_uid: "t1", applied_money: { amount: 65, currency: "USD" } }],
      },
    ]);
    (order as { taxes?: Order["taxes"] }).taxes = [
      { uid: "t1", catalog_object_id: "TAX_GEN", name: "General Sales Tax", percentage: "7.25" },
    ];
    const rows = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    const db = invoiceLineItemsWithTaxesStub();

    const { error } = await persistInvoiceLineItems(db.client, "INV1", rows, order);

    expect(error).toBeUndefined();
    expect(db.taxRows()).toEqual([
      { line_item_id: "row-0", square_tax_id: "TAX_GEN", tax_name: "General Sales Tax", tax_pct: 7.25, amount_cents: 65 },
    ]);
  });

  it("deletes stale tax rows unconditionally when the invoice no longer has any", async () => {
    const order = orderWith([
      { uid: "u-a", quantity: "1", name: "Packaging Fee", gross_sales_money: { amount: 100, currency: "USD" }, total_money: { amount: 100, currency: "USD" } },
    ]);
    const rows = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    const db = invoiceLineItemsWithTaxesStub(rows);
    // Seed a stale tax row directly, as if a previous sync (with a tax on this
    // line) had written it.
    await db.client.from("invoice_line_item_taxes").insert([
      { line_item_id: "row-0", square_tax_id: "TAX_GEN", tax_name: "General Sales Tax", tax_pct: 7.25, amount_cents: 999 },
    ]);

    const { error } = await persistInvoiceLineItems(db.client, "INV1", rows, order);

    expect(error).toBeUndefined();
    expect(db.taxRows()).toEqual([]);
  });

  it("does not touch invoice_line_item_taxes when no order is passed", async () => {
    const order = orderWith([
      { uid: "u-a", quantity: "1", name: "Packaging Fee", gross_sales_money: { amount: 100, currency: "USD" }, total_money: { amount: 100, currency: "USD" } },
    ]);
    const rows = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    const db = invoiceLineItemsStub();

    const { error } = await persistInvoiceLineItems(db.client, "INV1", rows);

    expect(error).toBeUndefined();
  });
});

describe("invoiceHeaderTotalsFromOrder", () => {
  it("uses order.total_money as authoritative and sums order-scoped discounts", () => {
    const order = orderWith(
      [{ uid: "u", quantity: "1", name: "x", gross_sales_money: { amount: 100, currency: "USD" }, total_money: { amount: 100, currency: "USD" } }],
      [{ uid: "d", name: "Coupon", scope: "ORDER", applied_money: { amount: 50, currency: "USD" } }],
    );
    (order as { total_money: { amount: number; currency: string } }).total_money = { amount: 50, currency: "USD" };
    (order as { total_tax_money?: { amount: number; currency: string } }).total_tax_money = { amount: 0, currency: "USD" };
    const t = invoiceHeaderTotalsFromOrder(order);
    expect(t.total_cents).toBe(50);
    expect(t.discount_cents).toBe(50);
  });
});
