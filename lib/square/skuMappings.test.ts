import { describe, it, expect } from "vitest";
import { selectServiceMapping, type ServiceMappingRow } from "./skuMappings";

function row(p: Partial<ServiceMappingRow>): ServiceMappingRow {
  return {
    service_type: "packaging_fee",
    partner_id: null,
    packaging_item_id: null,
    packaging_format: null,
    square_catalog_item_id: null,
    square_catalog_variation_id: null,
    square_catalog_discount_id: null,
    display_name: null,
    ...p,
  };
}

describe("selectServiceMapping", () => {
  const rows = [
    row({ service_type: "packaging_fee", partner_id: null, packaging_item_id: "c1", packaging_format: "case", display_name: "default-case" }),
    row({ service_type: "packaging_fee", partner_id: "p1", packaging_item_id: "c1", packaging_format: "case", display_name: "partner-case" }),
    row({ service_type: "keg_cleaning", partner_id: null, display_name: "kegclean" }),
  ];

  it("prefers the partner-specific row over the default", () => {
    const m = selectServiceMapping(rows, { serviceType: "packaging_fee", partnerId: "p1", packagingItemId: "c1", packagingFormat: "case" });
    expect(m?.display_name).toBe("partner-case");
  });

  it("falls back to the partner_id-null default", () => {
    const m = selectServiceMapping(rows, { serviceType: "packaging_fee", partnerId: "p2", packagingItemId: "c1", packagingFormat: "case" });
    expect(m?.display_name).toBe("default-case");
  });

  it("matches container-less services", () => {
    const m = selectServiceMapping(rows, { serviceType: "keg_cleaning", partnerId: "p1", packagingItemId: null, packagingFormat: null });
    expect(m?.display_name).toBe("kegclean");
  });

  it("returns null when nothing matches", () => {
    const m = selectServiceMapping(rows, { serviceType: "forklift", partnerId: null, packagingItemId: null, packagingFormat: null });
    expect(m).toBeNull();
  });
});
