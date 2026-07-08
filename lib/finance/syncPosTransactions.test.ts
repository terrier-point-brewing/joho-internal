import { describe, it, expect } from "vitest";
import {
  classifyOrderForSync,
  buildCoaResolvers,
  buildInvoiceLookup,
  buildOrderPayload,
  buildPosLineItems,
  buildInvoiceLineItems,
  type CatalogCoaMapping,
} from "./syncPosTransactions";
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
      total_money: { amount: 1350, currency: "USD" },
    },
  ],
};

describe("classifyOrderForSync", () => {
  it("upserts COMPLETED, cancels CANCELED, skips the rest", () => {
    expect(classifyOrderForSync({ state: "COMPLETED" })).toBe("upsert");
    expect(classifyOrderForSync({ state: "CANCELED" })).toBe("cancel");
    expect(classifyOrderForSync({ state: "OPEN" })).toBe("skip");
    expect(classifyOrderForSync({ state: "DRAFT" })).toBe("skip");
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
    const p = buildOrderPayload(order, null, "2026-07-06T00:00:00Z");
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
      updated_at: "2026-07-06T00:00:00Z",
    });
  });

  it("passes through the invoice id when invoice-backed", () => {
    expect(buildOrderPayload(order, "INV_9", "2026-07-06T00:00:00Z").invoice_id).toBe("INV_9");
  });

  it("falls back to updated_at then created_at when closed_at is missing", () => {
    const noClose = { ...order, closed_at: undefined };
    expect(buildOrderPayload(noClose, null, "x").transaction_date).toBe("2026-07-01T10:05:00Z");
    const created = { ...order, closed_at: undefined, updated_at: undefined };
    expect(buildOrderPayload(created, null, "x").transaction_date).toBe("2026-07-01T10:00:00Z");
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
});

describe("buildInvoiceLineItems", () => {
  it("builds invoice rows with a 1-based sort order and joined description", () => {
    const items = buildInvoiceLineItems("INV_1", order, () => "COA_INV");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      invoice_id: "INV_1",
      sort_order: 1,
      description: "Hazy IPA – Pint",
      quantity: 2,
      unit_price_cents: 700,
      total_cents: 1350,
      gross_sales_cents: 1400,
      net_sales_cents: 1350,
      square_variation_id: "VAR_A",
      chart_of_accounts_id: "COA_INV",
    });
  });
});
