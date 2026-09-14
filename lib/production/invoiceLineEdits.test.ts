import { describe, it, expect } from "vitest";
import { diffInvoiceLines, summarizeLineEdits } from "./invoiceLineEdits";

const gen = [
  { id: "a", description: "Packaging Fee — Epic Hazy", quantity: 8, unitPriceCents: 4500 },
  { id: "b", description: "Keg Cleaning Service", quantity: 8, unitPriceCents: 300 },
  { id: "c", description: "Forklift Service Fee", quantity: 1, unitPriceCents: 500 },
];

describe("diffInvoiceLines", () => {
  it("returns nothing when the invoice goes out as generated", () => {
    expect(diffInvoiceLines(gen, gen)).toEqual([]);
    expect(summarizeLineEdits([])).toBe("as generated");
  });

  it("records a changed price, a removed line and a hand-added line, with before/after", () => {
    const final = [
      { ...gen[0], unitPriceCents: 4000 },
      gen[2],
      { id: "x", description: "Rush fee", quantity: 1, unitPriceCents: 2500 },
    ];
    const edits = diffInvoiceLines(gen, final);
    expect(edits).toEqual([
      { kind: "changed", description: gen[0].description, before: { quantity: 8, unitPriceCents: 4500, description: gen[0].description }, after: { quantity: 8, unitPriceCents: 4000, description: gen[0].description } },
      { kind: "removed", description: gen[1].description, before: { quantity: 8, unitPriceCents: 300, description: gen[1].description }, after: null },
      { kind: "added", description: "Rush fee", before: null, after: { quantity: 1, unitPriceCents: 2500, description: "Rush fee" } },
    ]);
    expect(summarizeLineEdits(edits)).toBe("1 changed, 1 removed, 1 added by hand");
  });

  it("ignores the deposit lines the modal adds itself", () => {
    const final = [...gen, { id: "dep", description: "Ingredient Deposit — B-056", quantity: 1, unitPriceCents: 48218 }];
    expect(diffInvoiceLines(gen, final, new Set(["dep"]))).toEqual([]);
  });
});
