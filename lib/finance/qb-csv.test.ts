import { describe, it, expect } from "vitest";
import { autoDetectColumns, buildImportPayloads, type ColumnMap } from "./qb-csv";

const fullColMap: ColumnMap = {
  invoice_number: "Num",
  invoice_date: "Date",
  due_date: "Due Date",
  customer_name: "Customer",
  description: "Product/Service",
  quantity: "Qty",
  unit_price: "Rate",
  amount: "Amount",
  status: "Status",
};

describe("autoDetectColumns", () => {
  it("maps standard QB Online headers to fields", () => {
    const headers = ["Num", "Date", "Due Date", "Customer", "Product/Service", "Qty", "Rate", "Amount", "Status"];
    const map = autoDetectColumns(headers);
    expect(map.invoice_number).toBe("Num");
    expect(map.due_date).toBe("Due Date");
    expect(map.customer_name).toBe("Customer");
    expect(map.description).toBe("Product/Service");
    expect(map.quantity).toBe("Qty");
    expect(map.unit_price).toBe("Rate");
    expect(map.amount).toBe("Amount");
    expect(map.status).toBe("Status");
  });

  it("is case-insensitive and trims when matching hints", () => {
    const headers = ["  INVOICE NUMBER  ", "TXN DATE", "CLIENT"];
    const map = autoDetectColumns(headers);
    // Returns the original (untrimmed) header text for the matched column.
    expect(map.invoice_number).toBe("  INVOICE NUMBER  ");
    expect(map.invoice_date).toBe("TXN DATE");
    expect(map.customer_name).toBe("CLIENT");
  });

  it("returns empty string for fields with no matching header", () => {
    const map = autoDetectColumns(["Num"]);
    expect(map.invoice_number).toBe("Num");
    expect(map.status).toBe("");
    expect(map.quantity).toBe("");
  });

  it("returns all empty strings for empty header list", () => {
    const map = autoDetectColumns([]);
    expect(Object.values(map).every((v) => v === "")).toBe(true);
  });

  it("matches the first header that contains a hint substring", () => {
    // "date" hint matches "Invoice Date" before "Due Date" by header order.
    const headers = ["Invoice Date", "Due Date"];
    const map = autoDetectColumns(headers);
    expect(map.invoice_date).toBe("Invoice Date");
  });
});

describe("buildImportPayloads", () => {
  it("returns a warning and no invoices for empty CSV", () => {
    const result = buildImportPayloads("", fullColMap);
    expect(result.invoices).toEqual([]);
    expect(result.skipped).toBe(0);
    expect(result.warnings).toContain("CSV is empty");
  });

  it("parses a single-line invoice into one payload", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      "1001,1/15/2024,2/14/2024,Acme,Keg Cleaning,1,75.00,75.00,Paid",
    ].join("\n");
    const { invoices, skipped, warnings } = buildImportPayloads(csv, fullColMap);
    expect(skipped).toBe(0);
    expect(warnings).toEqual([]);
    expect(invoices).toHaveLength(1);
    const inv = invoices[0];
    expect(inv.source).toBe("quickbooks");
    expect(inv.external_id).toBe("1001");
    expect(inv.invoice_number).toBe("1001");
    expect(inv.invoice_date).toBe("2024-01-15");
    expect(inv.due_date).toBe("2024-02-14");
    expect(inv.customer_name).toBe("Acme");
    expect(inv.status).toBe("paid");
    expect(inv.total_cents).toBe(7500);
    expect(inv.subtotal_cents).toBe(7500);
    expect(inv.tax_cents).toBe(0);
    expect(inv.line_items).toHaveLength(1);
    expect(inv.line_items[0].sort_order).toBe(0);
    expect(inv.line_items[0].description).toBe("Keg Cleaning");
    expect(inv.line_items[0].quantity).toBe(1);
    expect(inv.line_items[0].unit_price_cents).toBe(7500);
    expect(inv.line_items[0].total_cents).toBe(7500);
  });

  it("groups multiple rows with the same invoice number and sums totals", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      "2001,1/1/2024,1/31/2024,Beta,Packaging Fee,10,15.00,150.00,Open",
      "2001,1/1/2024,1/31/2024,Beta,Keg Cleaning,1,75.00,75.00,Open",
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].line_items).toHaveLength(2);
    expect(invoices[0].total_cents).toBe(15000 + 7500);
    // sort_order is sequential within the group
    expect(invoices[0].line_items.map((l) => l.sort_order)).toEqual([0, 1]);
  });

  it("uses header values from the first row of the group", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      "3001,1/1/2024,1/31/2024,FirstCust,A,1,10.00,10.00,Paid",
      "3001,2/2/2024,2/28/2024,SecondCust,B,1,20.00,20.00,Open",
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    expect(invoices[0].customer_name).toBe("FirstCust");
    expect(invoices[0].invoice_date).toBe("2024-01-01");
    expect(invoices[0].status).toBe("paid");
  });

  it("counts rows without an invoice number as skipped", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      ",1/1/2024,,NoNum,Orphan Line,1,5.00,5.00,Paid",
      "4001,1/1/2024,,HasNum,Real Line,1,5.00,5.00,Paid",
    ].join("\n");
    const { invoices, skipped } = buildImportPayloads(csv, fullColMap);
    expect(skipped).toBe(1);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].external_id).toBe("4001");
  });

  it("defaults missing customer to 'Unknown'", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      "5001,1/1/2024,,,Service,1,5.00,5.00,Paid",
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    expect(invoices[0].customer_name).toBe("Unknown");
  });

  it("defaults missing description to '(no description)' and quantity to 1", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      "6001,1/1/2024,,Cust,,,5.00,5.00,Paid",
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    expect(invoices[0].line_items[0].description).toBe("(no description)");
    expect(invoices[0].line_items[0].quantity).toBe(1);
  });

  it("normalizes unknown status to 'unknown'", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      "7001,1/1/2024,,Cust,Service,1,5.00,5.00,???",
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    expect(invoices[0].status).toBe("unknown");
  });

  it("parses ISO (YYYY-MM-DD) dates as-is", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      "8001,2024-03-09,2024-04-08,Cust,Service,1,5.00,5.00,Paid",
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    expect(invoices[0].invoice_date).toBe("2024-03-09");
    expect(invoices[0].due_date).toBe("2024-04-08");
  });

  it("returns null invoice_date for unparseable date strings", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      "9001,notadate,,Cust,Service,1,5.00,5.00,Paid",
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    expect(invoices[0].invoice_date).toBeNull();
    expect(invoices[0].due_date).toBeNull();
  });

  it("parses negative money in parentheses (QB credit/negative)", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      "1100,1/1/2024,,Cust,Credit,1,(50.00),(50.00),Paid",
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    expect(invoices[0].line_items[0].total_cents).toBe(-5000);
    expect(invoices[0].total_cents).toBe(-5000);
  });

  it("strips $ and thousands separators from money", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      '1200,1/1/2024,,Cust,Big Order,1,"$1,234.56","$1,234.56",Paid',
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    expect(invoices[0].line_items[0].total_cents).toBe(123456);
  });

  it("treats non-numeric money as zero", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      "1300,1/1/2024,,Cust,Service,1,abc,xyz,Paid",
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    expect(invoices[0].line_items[0].unit_price_cents).toBe(0);
    expect(invoices[0].line_items[0].total_cents).toBe(0);
  });

  it("handles quoted fields containing commas", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      '1400,1/1/2024,,"Smith, John",Service,1,10.00,10.00,Paid',
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    expect(invoices[0].customer_name).toBe("Smith, John");
  });

  it("handles escaped double-quotes inside quoted fields", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      '1500,1/1/2024,,Cust,"6"" Keg Riser",1,10.00,10.00,Paid',
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    expect(invoices[0].line_items[0].description).toBe('6" Keg Riser');
  });

  it("preserves the full raw row keyed by header in line raw_data", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      "1600,1/1/2024,,Cust,Service,2,5.00,10.00,Paid",
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    const raw = invoices[0].line_items[0].raw_data;
    expect(raw["Num"]).toBe("1600");
    expect(raw["Amount"]).toBe("10.00");
    expect(raw["Qty"]).toBe("2");
  });

  it("skips blank lines in the CSV body", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      "",
      "1700,1/1/2024,,Cust,Service,1,5.00,5.00,Paid",
      "   ",
    ].join("\n");
    const { invoices, skipped } = buildImportPayloads(csv, fullColMap);
    expect(invoices).toHaveLength(1);
    expect(skipped).toBe(0);
  });

  it("rounds fractional cents to the nearest cent", () => {
    const csv = [
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status",
      "1800,1/1/2024,,Cust,Service,1,0.005,0.005,Paid",
    ].join("\n");
    const { invoices } = buildImportPayloads(csv, fullColMap);
    // 0.005 * 100 = 0.5 → Math.round → 1
    expect(invoices[0].line_items[0].total_cents).toBe(1);
  });

  it("normalizes CRLF line endings", () => {
    const csv =
      "Num,Date,Due Date,Customer,Product/Service,Qty,Rate,Amount,Status\r\n" +
      "1900,1/1/2024,,Cust,Service,1,5.00,5.00,Paid\r\n";
    const { invoices } = buildImportPayloads(csv, fullColMap);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].line_items[0].total_cents).toBe(500);
  });
});
