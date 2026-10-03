import { describe, it, expect } from "vitest";
import { buildShippingReportLines, parseShippingReportLines, type ShippingReportRow } from "./shippingReport";

const row = (o: Partial<ShippingReportRow>): ShippingReportRow => ({
  groupKey: "inv-1",
  shippedAt: "2026-07-10T15:00:00Z",
  invoiceDate: "2026-07-11",
  invoiceNumber: "1001",
  name: "Acme Wholesale",
  address: "1 Main St, Raleigh, NC",
  volumeBbl: 1,
  ...o,
});

describe("buildShippingReportLines", () => {
  it("returns no lines when there are no wholesale shipments", () => {
    expect(buildShippingReportLines([], 0)).toEqual([]);
  });

  it("collapses rows on the same invoice into one line", () => {
    const lines = buildShippingReportLines([row({ volumeBbl: 2 }), row({ volumeBbl: 3 })], 155);
    expect(lines).toEqual([
      { invoiceDate: "2026-07-11", invoiceNumber: "1001", name: "Acme Wholesale", address: "1 Main St, Raleigh, NC", gallons: 155 },
    ]);
  });

  it("orders lines by invoice date, then invoice number", () => {
    const lines = buildShippingReportLines(
      [
        row({ groupKey: "c", invoiceDate: "2026-07-20", invoiceNumber: "1003" }),
        row({ groupKey: "b", invoiceDate: "2026-07-05", invoiceNumber: "1002" }),
        row({ groupKey: "a", invoiceDate: "2026-07-05", invoiceNumber: "1001" }),
      ],
      93,
    );
    expect(lines.map((l) => l.invoiceNumber)).toEqual(["1001", "1002", "1003"]);
  });

  it("falls back to the ship date for a shipment that isn't invoiced yet", () => {
    const [line] = buildShippingReportLines([row({ groupKey: "ship-9", invoiceDate: null, invoiceNumber: null })], 31);
    expect(line.invoiceDate).toBe("2026-07-10");
    expect(line.invoiceNumber).toBeNull();
  });

  it("ties the lines to the B-C-710 wholesale total by carrying rounding on the last line", () => {
    // 0.4 bbl = 12.4 gal → 12 each (36), but the month's 1.2 bbl rounds to 37.
    const rows = ["a", "b", "c"].map((k, i) => row({ groupKey: k, invoiceNumber: `100${i}`, volumeBbl: 0.4 }));
    const lines = buildShippingReportLines(rows, 37);
    expect(lines.map((l) => l.gallons)).toEqual([12, 12, 13]);
  });
});

describe("parseShippingReportLines", () => {
  it("round-trips what the worksheet stores", () => {
    const lines = buildShippingReportLines([row({})], 31);
    expect(parseShippingReportLines(JSON.stringify(lines))).toEqual(lines);
  });
  it.each([null, undefined, "", "not json", "{}", 5])("treats %s as no lines", (v) => {
    expect(parseShippingReportLines(v as string | null)).toEqual([]);
  });
});
