import { describe, it, expect } from "vitest";
import { customerDisplayName, customerAddressString, type SquareCustomer } from "./customers";

describe("customerDisplayName", () => {
  it("returns 'Unknown' for an undefined customer", () => {
    expect(customerDisplayName(undefined)).toBe("Unknown");
  });

  it("prefers the company name when present", () => {
    const c: SquareCustomer = { id: "c1", company_name: "Acme Bar", given_name: "Jane", family_name: "Doe" };
    expect(customerDisplayName(c)).toBe("Acme Bar");
  });

  it("joins given and family name when there is no company", () => {
    const c: SquareCustomer = { id: "c1", given_name: "Jane", family_name: "Doe" };
    expect(customerDisplayName(c)).toBe("Jane Doe");
  });

  it("uses only the given name when family is missing", () => {
    const c: SquareCustomer = { id: "c1", given_name: "Jane" };
    expect(customerDisplayName(c)).toBe("Jane");
  });

  it("uses only the family name when given is missing", () => {
    const c: SquareCustomer = { id: "c1", family_name: "Doe" };
    expect(customerDisplayName(c)).toBe("Doe");
  });

  it("falls back to the id when no name fields are present", () => {
    const c: SquareCustomer = { id: "c-123" };
    expect(customerDisplayName(c)).toBe("c-123");
  });

  it("falls back to the id when name fields are empty strings", () => {
    const c: SquareCustomer = { id: "c-123", given_name: "", family_name: "" };
    expect(customerDisplayName(c)).toBe("c-123");
  });
});

describe("customerAddressString", () => {
  it("returns an empty string when there is no address", () => {
    expect(customerAddressString({ id: "c1" })).toBe("");
  });

  it("joins all present address parts in order with commas", () => {
    const c: SquareCustomer = {
      id: "c1",
      address: {
        address_line_1: "123 Main St",
        address_line_2: "Suite 4",
        locality: "Holly Springs",
        administrative_district_level_1: "NC",
        postal_code: "27540",
      },
    };
    expect(customerAddressString(c)).toBe("123 Main St, Suite 4, Holly Springs, NC, 27540");
  });

  it("omits missing parts (no double commas)", () => {
    const c: SquareCustomer = {
      id: "c1",
      address: { address_line_1: "123 Main St", locality: "Holly Springs", administrative_district_level_1: "NC" },
    };
    expect(customerAddressString(c)).toBe("123 Main St, Holly Springs, NC");
  });

  it("does not include the country (only line1/line2/city/state/zip)", () => {
    const c: SquareCustomer = {
      id: "c1",
      address: { address_line_1: "123 Main St", country: "US" },
    };
    expect(customerAddressString(c)).toBe("123 Main St");
  });

  it("returns an empty string for an address with only empty/blank fields", () => {
    const c: SquareCustomer = { id: "c1", address: { address_line_1: "", locality: "" } };
    expect(customerAddressString(c)).toBe("");
  });
});
