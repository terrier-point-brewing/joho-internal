import { describe, it, expect } from "vitest";
import { deriveChannel, derivePosCategory, deriveKegSize } from "./dimensions";

describe("deriveChannel", () => {
  it("POS row (invoiceId null, not an event pour) -> taproom", () => {
    expect(deriveChannel({ invoiceId: null, isEventPour: false, exportChannel: null })).toBe("taproom");
  });

  it("event-pour item -> events", () => {
    expect(deriveChannel({ invoiceId: null, isEventPour: true, exportChannel: null })).toBe("events");
  });

  it("event-pour item on an invoice-backed row still -> events (takes priority)", () => {
    expect(deriveChannel({ invoiceId: "inv-1", isEventPour: true, exportChannel: "distribution" })).toBe("events");
  });

  it("invoice-backed row with exportChannel=distribution -> distribution", () => {
    expect(deriveChannel({ invoiceId: "inv-1", isEventPour: false, exportChannel: "distribution" })).toBe("distribution");
  });

  it("invoice-backed row with exportChannel=contract_brewing -> contract_brewing", () => {
    expect(deriveChannel({ invoiceId: "inv-1", isEventPour: false, exportChannel: "contract_brewing" })).toBe("contract_brewing");
  });

  it("invoice-backed row with exportChannel=wholesale -> wholesale", () => {
    expect(deriveChannel({ invoiceId: "inv-1", isEventPour: false, exportChannel: "wholesale" })).toBe("wholesale");
  });

  it("invoice-backed row with missing exportChannel -> unknown", () => {
    expect(deriveChannel({ invoiceId: "inv-1", isEventPour: false, exportChannel: null })).toBe("unknown");
  });

  it("invoice-backed row with unrecognized exportChannel -> unknown", () => {
    expect(deriveChannel({ invoiceId: "inv-1", isEventPour: false, exportChannel: "some_other_thing" })).toBe("unknown");
  });
});

describe("derivePosCategory", () => {
  it("maps a Draft-category variation to the shared DRAFT_BEER category", () => {
    expect(derivePosCategory({ categoryId: "567KQPEBRBZHG7ATHQFRCRWZ" })).toBe("DRAFT_BEER");
  });

  it("maps the Holly Springs equivalent Draft category to the same DRAFT_BEER id", () => {
    expect(derivePosCategory({ categoryId: "DCPYMNVDYNX4JAFI22DMVKLN" })).toBe("DRAFT_BEER");
  });

  it("maps a Cans-category variation to CANS", () => {
    expect(derivePosCategory({ categoryId: "Q5BMUOAOCBOUS4JNDRAAXA4Q" })).toBe("CANS");
  });

  it("null categoryId -> null", () => {
    expect(derivePosCategory({ categoryId: null })).toBeNull();
  });

  it("unrecognized categoryId -> null", () => {
    expect(derivePosCategory({ categoryId: "NOT_A_REAL_CATEGORY_ID" })).toBeNull();
  });
});

describe("deriveKegSize", () => {
  it("name containing 1/2 -> half", () => {
    expect(deriveKegSize("1/2 Keg")).toBe("half");
  });

  it("name containing 1/4 -> quarter", () => {
    expect(deriveKegSize("1/4 Keg")).toBe("quarter");
  });

  it("name containing 1/6 -> sixth", () => {
    expect(deriveKegSize("1/6 Keg")).toBe("sixth");
  });

  it("name with a beer-specific prefix still matches on the fraction", () => {
    expect(deriveKegSize("Fortnight Blank Coast IPA - 1/6 Keg")).toBe("sixth");
  });

  it("name containing 'can' -> can", () => {
    expect(deriveKegSize("16oz Can 4-Pack")).toBe("can");
  });

  it("unmatched name -> null", () => {
    expect(deriveKegSize("Merchandise T-Shirt")).toBeNull();
  });
});
