import { describe, it, expect } from "vitest";
import { bucketOrderLinesByDay, extractRestockLineItems, type DayBucketOrder } from "./inventory";
import { KEG_TRANSFER_DISCOUNT_NAME } from "@/types/reports";

// Order shape accepted by the restock extractor (a subset of lib/square Order).
type ScanOrder = Parameters<typeof extractRestockLineItems>[0][number];

describe("bucketOrderLinesByDay", () => {
  it("buckets a variation across two different days", () => {
    const orders: DayBucketOrder[] = [
      { closed_at: "2026-07-01T15:00:00Z", line_items: [{ catalog_object_id: "V1", quantity: "2" }] },
      { closed_at: "2026-07-02T09:30:00Z", line_items: [{ catalog_object_id: "V1", quantity: "3" }] },
    ];

    const map = bucketOrderLinesByDay(orders);

    expect(map.get("V1\t2026-07-01")).toBe(2);
    expect(map.get("V1\t2026-07-02")).toBe(3);
    expect(map.size).toBe(2);
  });

  it("sums multiple lines and multiple orders for the same (variation, day)", () => {
    const orders: DayBucketOrder[] = [
      {
        closed_at: "2026-07-01T12:00:00Z",
        line_items: [
          { catalog_object_id: "V1", quantity: "1" },
          { catalog_object_id: "V1", quantity: "2" },
          { catalog_object_id: "V2", quantity: "5" },
        ],
      },
      {
        closed_at: "2026-07-01T18:00:00Z",
        line_items: [{ catalog_object_id: "V1", quantity: "4" }],
      },
    ];

    const map = bucketOrderLinesByDay(orders);

    expect(map.get("V1\t2026-07-01")).toBe(7);
    expect(map.get("V2\t2026-07-01")).toBe(5);
  });

  it("falls back to created_at when closed_at is missing", () => {
    const orders: DayBucketOrder[] = [
      { created_at: "2026-07-03T08:00:00Z", line_items: [{ catalog_object_id: "V1", quantity: "1" }] },
    ];

    const map = bucketOrderLinesByDay(orders);

    expect(map.get("V1\t2026-07-03")).toBe(1);
  });

  it("only counts variations in the ids filter", () => {
    const orders: DayBucketOrder[] = [
      {
        closed_at: "2026-07-01T12:00:00Z",
        line_items: [
          { catalog_object_id: "V1", quantity: "2" },
          { catalog_object_id: "V2", quantity: "9" },
        ],
      },
    ];

    const map = bucketOrderLinesByDay(orders, { ids: ["V1"] });

    expect(map.get("V1\t2026-07-01")).toBe(2);
    expect(map.has("V2\t2026-07-01")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("excludes Invoices-sourced orders", () => {
    const orders: DayBucketOrder[] = [
      {
        closed_at: "2026-07-01T12:00:00Z",
        source: { name: "Invoices" },
        line_items: [{ catalog_object_id: "V1", quantity: "10" }],
      },
      {
        closed_at: "2026-07-01T13:00:00Z",
        source: { name: "Square Point of Sale" },
        line_items: [{ catalog_object_id: "V1", quantity: "2" }],
      },
    ];

    const map = bucketOrderLinesByDay(orders);

    expect(map.get("V1\t2026-07-01")).toBe(2);
  });

  it("drops keg-transfer lines but keeps normal lines when excludeTransfers is set", () => {
    const orders: DayBucketOrder[] = [
      {
        closed_at: "2026-07-01T12:00:00Z",
        discounts: [
          { uid: "d-transfer", name: KEG_TRANSFER_DISCOUNT_NAME },
          { uid: "d-happy", name: "Happy Hour" },
        ],
        line_items: [
          {
            catalog_object_id: "KEG",
            quantity: "1",
            applied_discounts: [{ discount_uid: "d-transfer" }],
          },
          {
            catalog_object_id: "V1",
            quantity: "3",
            applied_discounts: [{ discount_uid: "d-happy" }],
          },
        ],
      },
    ];

    const map = bucketOrderLinesByDay(orders, { excludeTransfers: true });

    expect(map.has("KEG\t2026-07-01")).toBe(false);
    expect(map.get("V1\t2026-07-01")).toBe(3);
  });

  it("keeps keg-transfer lines when excludeTransfers is not set", () => {
    const orders: DayBucketOrder[] = [
      {
        closed_at: "2026-07-01T12:00:00Z",
        discounts: [{ uid: "d-transfer", name: KEG_TRANSFER_DISCOUNT_NAME }],
        line_items: [
          {
            catalog_object_id: "KEG",
            quantity: "1",
            applied_discounts: [{ discount_uid: "d-transfer" }],
          },
        ],
      },
    ];

    const map = bucketOrderLinesByDay(orders);

    expect(map.get("KEG\t2026-07-01")).toBe(1);
  });

  it("skips orders missing both timestamps", () => {
    const orders: DayBucketOrder[] = [
      { line_items: [{ catalog_object_id: "V1", quantity: "5" }] },
    ];

    const map = bucketOrderLinesByDay(orders);

    expect(map.size).toBe(0);
  });

  it("skips lines without a catalog_object_id or with non-positive quantity", () => {
    const orders: DayBucketOrder[] = [
      {
        closed_at: "2026-07-01T12:00:00Z",
        line_items: [
          { quantity: "5" },
          { catalog_object_id: "V1", quantity: "0" },
          { catalog_object_id: "V1", quantity: "-2" },
          { catalog_object_id: "V1", quantity: "2" },
        ],
      },
    ];

    const map = bucketOrderLinesByDay(orders);

    expect(map.get("V1\t2026-07-01")).toBe(2);
    expect(map.size).toBe(1);
  });
});

describe("extractRestockLineItems", () => {
  const RESTOCK = ["tap1-var", "tap3-var"];

  it("returns one event per matching restock line, keyed by order + line uid", () => {
    const orders: ScanOrder[] = [
      {
        id: "o1",
        closed_at: "2026-07-04T20:00:00Z",
        line_items: [
          { uid: "li-a", catalog_object_id: "tap1-var", quantity: "1" },
          { uid: "li-b", catalog_object_id: "some-beer", quantity: "2" }, // not a restock
        ],
      },
    ];

    const events = extractRestockLineItems(orders, RESTOCK);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      orderId: "o1",
      lineUid: "li-a",
      squareVariationId: "tap1-var",
      quantity: 1,
      occurredAt: "2026-07-04T20:00:00Z",
    });
  });

  it("uses closed_at, falling back to created_at, and skips lines with neither", () => {
    const orders: ScanOrder[] = [
      { id: "o2", created_at: "2026-07-04T10:00:00Z", line_items: [{ uid: "x", catalog_object_id: "tap3-var", quantity: "1" }] },
      { id: "o3", line_items: [{ uid: "y", catalog_object_id: "tap3-var", quantity: "1" }] }, // no timestamp → skipped
    ];

    const events = extractRestockLineItems(orders, RESTOCK);
    expect(events).toHaveLength(1);
    expect(events[0].occurredAt).toBe("2026-07-04T10:00:00Z");
  });

  it("defaults non-positive or missing quantity to 1 and falls back lineUid to the variation id", () => {
    const orders: ScanOrder[] = [
      { id: "o4", closed_at: "2026-07-04T12:00:00Z", line_items: [{ catalog_object_id: "tap1-var" }] },
    ];

    const events = extractRestockLineItems(orders, RESTOCK);
    expect(events[0].quantity).toBe(1);
    expect(events[0].lineUid).toBe("tap1-var");
  });

  it("skips invoice-sourced orders and returns nothing when no restock ids are given", () => {
    const orders: ScanOrder[] = [
      { id: "o5", closed_at: "2026-07-04T12:00:00Z", source: { name: "Invoices" }, line_items: [{ uid: "z", catalog_object_id: "tap1-var", quantity: "1" }] },
    ];

    expect(extractRestockLineItems(orders, RESTOCK)).toHaveLength(0);
    expect(extractRestockLineItems([{ id: "o6", closed_at: "2026-07-04T12:00:00Z", line_items: [{ uid: "z", catalog_object_id: "tap1-var", quantity: "1" }] }], [])).toHaveLength(0);
  });
});
