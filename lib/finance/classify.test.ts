import { describe, it, expect } from "vitest";
import { classifyLineItem, normalizeStatus } from "./classify";

describe("classifyLineItem", () => {
  it("routes ingredient deposit to ingredient_deposit", () => {
    expect(classifyLineItem("Ingredient Deposit")).toBe("ingredient_deposit");
    expect(classifyLineItem("ingredient deposit — some variant")).toBe("ingredient_deposit");
  });

  it("routes packaging material to materials_packaging", () => {
    expect(classifyLineItem("Packaging Material — 12oz Cans")).toBe("materials_packaging");
    expect(classifyLineItem("packaging material")).toBe("materials_packaging");
  });

  it("ingredient deposit does NOT return materials_packaging", () => {
    expect(classifyLineItem("Ingredient Deposit")).not.toBe("materials_packaging");
  });

  it("routes packaging fee to packaging_fees", () => {
    expect(classifyLineItem("Packaging Fee")).toBe("packaging_fees");
  });

  it("routes keg cleaning to other_services", () => {
    expect(classifyLineItem("Keg Cleaning")).toBe("other_services");
    expect(classifyLineItem("forklift service")).toBe("other_services");
    expect(classifyLineItem("CO2 Refill")).toBe("other_services");
    expect(classifyLineItem("Keg Transformation")).toBe("other_services");
  });

  it("routes barrel excise tax to pass_through_taxes", () => {
    expect(classifyLineItem("Barrel Excise Tax")).toBe("pass_through_taxes");
  });

  it("returns other for unknown items", () => {
    expect(classifyLineItem("Some Random Service")).toBe("other");
  });
});

describe("normalizeStatus", () => {
  it("maps paid variants", () => {
    expect(normalizeStatus("Paid")).toBe("paid");
    expect(normalizeStatus("closed")).toBe("paid");
  });

  it("maps open variants", () => {
    expect(normalizeStatus("open")).toBe("open");
    expect(normalizeStatus("UNPAID")).toBe("open");
  });

  it("maps voided", () => {
    expect(normalizeStatus("Voided")).toBe("voided");
  });

  it("defaults to unknown", () => {
    expect(normalizeStatus("???")).toBe("unknown");
  });
});
