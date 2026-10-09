import { describe, it, expect } from "vitest";
import { invoicePaidOn } from "./invoicePaidOn";

describe("invoicePaidOn", () => {
  it("dates a paid invoice by when the customer paid, not when the transfer settled", () => {
    // Invoice #000006: paid 29 May, flipped to PAID by Square on 2 June. Dated
    // by the invoice it would still be owed on 31 May.
    expect(invoicePaidOn("paid", [{ created_at: "2026-05-29T14:41:23Z" }], "2026-06-02T12:05:37Z")).toBe("2026-05-29");
  });

  it("uses the brewery's calendar day, not UTC's", () => {
    // 9pm on 30 September in Holly Springs is already 1 October in UTC.
    expect(invoicePaidOn("paid", [{ created_at: "2026-10-01T01:00:00Z" }])).toBe("2026-09-30");
  });

  it("records nothing while a transfer is started but not settled", () => {
    // The tender exists the moment the customer starts paying; the invoice is
    // still open, and the date would have to be withdrawn if the transfer failed.
    expect(invoicePaidOn("open", [{ created_at: "2026-10-01T18:21:57Z" }])).toBeNull();
  });

  it("counts an invoice paid in instalments from the last one", () => {
    expect(
      invoicePaidOn("paid", [{ created_at: "2026-09-28T12:00:00Z" }, { created_at: "2026-10-03T12:00:00Z" }]),
    ).toBe("2026-10-03");
  });

  it("falls back to the invoice's own time rather than leave a paid invoice undated", () => {
    expect(invoicePaidOn("paid", [], "2026-08-20T12:05:10Z")).toBe("2026-08-20");
    expect(invoicePaidOn("paid", undefined, null)).toBeNull();
  });

  it("never dates a voided or draft invoice", () => {
    expect(invoicePaidOn("voided", [{ created_at: "2026-08-20T12:05:10Z" }])).toBeNull();
    expect(invoicePaidOn("draft", [])).toBeNull();
  });
});
