import { describe, it, expect } from "vitest";
import { checkFungibleGroup, type FungibleCandidate } from "./fungibleGroupRules";

const member = (over: Partial<FungibleCandidate> = {}): FungibleCandidate => ({
  variationId: "v1",
  variationName: "Printed Can Case",
  packaging: "can",
  partnerId: "argus",
  totalVolumeFlOz: 384,
  ...over,
});

describe("checkFungibleGroup", () => {
  // The case this exists for: one partner's beer, two cans, same size.
  it("allows two packagings of the same partner's beer at the same size", () => {
    expect(
      checkFungibleGroup([
        member(),
        member({ variationId: "v2", variationName: "Labeled Can Case" }),
      ]),
    ).toEqual({ ok: true });
  });

  it("allows two house packagings", () => {
    expect(
      checkFungibleGroup([
        member({ partnerId: null }),
        member({ variationId: "v2", partnerId: null }),
      ]),
    ).toEqual({ ok: true });
  });

  it("refuses to mix house and partner stock behind one button", () => {
    const result = checkFungibleGroup([
      member({ partnerId: null, variationName: "House 1/6 Keg" }),
      member({ variationId: "v2", partnerId: "fortnight", variationName: "Fortnight 1/6 Keg" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("partner");
  });

  it("refuses to mix two different partners", () => {
    const result = checkFungibleGroup([
      member({ partnerId: "argus" }),
      member({ variationId: "v2", partnerId: "fortnight" }),
    ]);
    expect(result.ok).toBe(false);
  });

  // One "unit sold" has to mean one amount of beer, or the excise moves with
  // whichever lot happened to be oldest.
  it("refuses different volumes behind one button", () => {
    const result = checkFungibleGroup([
      member({ totalVolumeFlOz: 384, variationName: "Case" }),
      member({ variationId: "v2", totalVolumeFlOz: 64, variationName: "4-Pack" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("same volume");
  });

  it("refuses a packaging with no coded volume, since nothing can check it", () => {
    const result = checkFungibleGroup([
      member(),
      member({ variationId: "v2", totalVolumeFlOz: null }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("coded volume");
  });

  it("refuses a keg and a can behind one button", () => {
    const result = checkFungibleGroup([
      member({ packaging: "can" }),
      member({ variationId: "v2", packaging: "keg" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("all kegs or all cans");
  });

  // The commonest way to hit this is picking "Regular" when you meant
  // "Regular - 16oz 4-Pack". Listing three packagings without naming what they
  // were being attached to leaves nothing to act on.
  it("names the Square item it refused, so the wrong sibling is obvious", () => {
    const result = checkFungibleGroup(
      [
        member({ totalVolumeFlOz: 16, variationName: "Printed Can" }),
        member({ variationId: "v2", totalVolumeFlOz: 64, variationName: "Printed Can 4-Pack" }),
      ],
      "Epic Hazy IPA (Cans) · Regular",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Epic Hazy IPA (Cans) · Regular");
      expect(result.reason).toContain("pick that Square item instead");
    }
  });

  it("has nothing to check below two members", () => {
    expect(checkFungibleGroup([member()])).toEqual({ ok: true });
    expect(checkFungibleGroup([])).toEqual({ ok: true });
  });
});
