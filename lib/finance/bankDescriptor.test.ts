import { describe, it, expect } from "vitest";
import {
  counterpartyFromDescriptor,
  specificCounterpartyFromDescriptor,
  originatorCounterpartyFromDescriptor,
} from "./bankDescriptor";
import { normalizeCounterparty } from "@/lib/ramp";

/**
 * Verbatim descriptors from the Chase feed, so the patterns are tested against
 * the strings they actually meet rather than tidied-up examples. Trimmed only
 * where a trace number ran long.
 */
const REAL = {
  square: "ORIG CO NAME:Square Inc ORIG ID:9424300002 DESC DATE:260812 CO ENTRY DESCR:SQ260812 SEC:PPD TRACE#:021000020275397 EED:260812 IND ID: IND NAME:TERRIER POINT BREWING TRN: 2240275397TC",
  rampWallet: "ORIG CO NAME:RAMP ORIG ID:9186939000 DESC DATE: CO ENTRY DESCR:DEPOSIT SEC:CCD TRACE#:074920908035895 EED:260812 IND ID: IND NAME:TPB OPERATING FUNDS RAMP WALLET DEPOSIT TRN: 2248035895TC",
  rampStatement: "ORIG CO NAME:RAMP STATEMENT ORIG ID:9186939000 DESC DATE:260520 CO ENTRY DESCR:N4AA7HT8E8SEC:CCD TRACE#:021000025171137 EED:260520 IND ID:C63509449 IND NAME:TPB OPERATING FUNDS NTE*ZZZ*PAYMENT S3365251\\ TRN: 1405171137TC",
  rampReimburseLiao: "ORIG CO NAME:RMPR W Liao ORIG ID:9186939000 DESC DATE: CO ENTRY DESCR:DGZGDHCWG7SEC:CCD TRACE#:074920904965700 EED:260728 IND ID: IND NAME:TPB OPERATING FUNDS Weining Liao TRN: 2094965700TC",
  rampReimburseWolford: "ORIG CO NAME:RMPR A Wolford ORIG ID:9186939000 DESC DATE: CO ENTRY DESCR:PVY4NMRKTFSEC:CCD TRACE#:074920905865561 EED:260527 IND ID: IND NAME:TPB OPERATING FUNDS Aliza Wolford TRN: 1475865561TC",
  acctVerify: "ORIG CO NAME:RAMP ORIG ID:9186939000 DESC DATE:260429 CO ENTRY DESCR:ACCTVERIFYSEC:CCD TRACE#:021000028403194 EED:260429 IND ID:C59742340 IND NAME:Terrier Point Brewing NTE*ZZZ*DEBIT CHECK CREDIT\\ TRN: 1198403194TC",
  transferChk: "Online Transfer from CHK ...9652 transaction#: 29634811058",
  transferSav: "Online Transfer from SAV ...1915 transaction#: 30199466236",
  zelle: "Zelle payment from WILLIAM LIAO 28830993165",
  check: "CHECK # 1002",
  wire: "DOMESTIC WIRE TRANSFER VIA: FIRST CITZ RALEIGH/053100300 A/C: MATHESON & ASSOCIATES PLLC TRUST REF:/TIME/20:59 IMAD: 0421MMQFMP2N027661 TRN: 3630106111ES 04/21",
  gustoNet: "ORIG CO NAME:GUSTO ORIG ID:9138864001 DESC DATE:260504 CO ENTRY DESCR:NET 125921SEC:CCD TRACE#:021000023972949 EED:260504 IND ID:6semk8idvh6 IND NAME:TERRIER POINT BREWING 6semjnt8vn1 TRN: 1243972949TC",
  intuitFee: "ORIG CO NAME:INTUIT 31134643 ORIG ID:9215986202 DESC DATE:260512 CO ENTRY DESCR:TRAN FEE SEC:CCD TRACE#:021000023789050 EED:260512 IND ID:524771240658131 IND NAME:TERRIER POINT BREWING TRN: 1323789050TC",
  intuitDeposit: "ORIG CO NAME:INTUIT 27275143 ORIG ID:9215986202 DESC DATE:260512 CO ENTRY DESCR:DEPOSIT SEC:CCD TRACE#:021000023760986 EED:260512 IND ID:524771240658131 IND NAME:TERRIER POINT BREWING TRN: 1323760986TC",
  deluxe: "ORIG CO NAME:DELUXE BUS SYS. ORIG ID:1411877307 DESC DATE: CO ENTRY DESCR:EDI/ACH SEC:CCD TRACE#:042000018136972 EED:260730 IND ID:17082002782768 IND NAME:TERRIER POINT BREWING ISA00 00 17091215 927 17072000326 260729174 48U0040100 TRN: 2118136972TC",
  businessBanking: "Business Banking Tiered",
};

describe("specific descriptor patterns", () => {
  // The whole reason the specific patterns run first: all three share ACH
  // company id 9186939000 and near-identical company names, but they are an
  // internal transfer, a settlement and an expense. Collapsing them to "Ramp"
  // gives all three whichever rule was written first, and every row still looks
  // confidently mapped.
  it("keeps Ramp's three movements apart", () => {
    expect(specificCounterpartyFromDescriptor(REAL.rampWallet)).toBe("Ramp Wallet");
    expect(specificCounterpartyFromDescriptor(REAL.rampStatement)).toBe("Ramp Card Statement");
    expect(specificCounterpartyFromDescriptor(REAL.rampReimburseLiao)).toBe("Ramp Reimbursement");
  });

  it("collapses every employee's reimbursement onto one counterparty", () => {
    expect(specificCounterpartyFromDescriptor(REAL.rampReimburseLiao))
      .toBe(specificCounterpartyFromDescriptor(REAL.rampReimburseWolford));
  });

  it("recognises micro-deposit verification ahead of the RAMP originator name", () => {
    expect(specificCounterpartyFromDescriptor(REAL.acctVerify)).toBe("Account Verification");
  });

  it("keys an own-account transfer by the account's last four", () => {
    expect(specificCounterpartyFromDescriptor(REAL.transferChk)).toBe("Chase ····9652");
    expect(specificCounterpartyFromDescriptor(REAL.transferSav)).toBe("Chase ····1915");
  });

  it("recognises Zelle", () => {
    expect(specificCounterpartyFromDescriptor(REAL.zelle)).toBe("Zelle");
  });

  it("names nobody for a cheque or a wire — those are a human's job", () => {
    expect(counterpartyFromDescriptor(REAL.check)).toBeNull();
    expect(counterpartyFromDescriptor(REAL.wire)).toBeNull();
    expect(counterpartyFromDescriptor(REAL.businessBanking)).toBeNull();
    expect(counterpartyFromDescriptor(null)).toBeNull();
    expect(counterpartyFromDescriptor("")).toBeNull();
  });
});

describe("originator field", () => {
  it("reads the company name, spaces and punctuation included", () => {
    expect(originatorCounterpartyFromDescriptor(REAL.deluxe)).toBe("DELUXE BUS SYS.");
    expect(originatorCounterpartyFromDescriptor(REAL.gustoNet)).toBe("GUSTO");
    expect(originatorCounterpartyFromDescriptor(REAL.square)).toBe("Square Inc");
  });

  // "INTUIT 31134643" and "INTUIT 27275143" are one counterparty with a
  // per-product suffix. Left intact they would need a rule each, forever.
  it("strips a numeric sub-account suffix so one vendor is one rule", () => {
    expect(originatorCounterpartyFromDescriptor(REAL.intuitFee)).toBe("INTUIT");
    expect(originatorCounterpartyFromDescriptor(REAL.intuitDeposit)).toBe("INTUIT");
  });

  it("never returns the recipient — IND NAME is us, on every single row", () => {
    for (const d of Object.values(REAL)) {
      const name = (counterpartyFromDescriptor(d) ?? "").toLowerCase();
      expect(name).not.toContain("terrier point");
      expect(name).not.toContain("tpb operating");
    }
  });

  it("yields nothing when there is no originator field", () => {
    expect(originatorCounterpartyFromDescriptor(REAL.check)).toBeNull();
    expect(originatorCounterpartyFromDescriptor(REAL.wire)).toBeNull();
  });
});

describe("the whole chain", () => {
  it("prefers a feed-supplied name over the raw originator field", () => {
    expect(counterpartyFromDescriptor(REAL.deluxe, "Deluxe Bus Sys.")).toBe("Deluxe Bus Sys.");
  });

  it("but a specific pattern still beats the feed", () => {
    // Plaid saying "Ramp" for a wallet funding would otherwise merge it with the
    // card statement and the reimbursements.
    expect(counterpartyFromDescriptor(REAL.rampWallet, "Ramp")).toBe("Ramp Wallet");
  });

  it("falls through to the originator field when the feed said nothing", () => {
    expect(counterpartyFromDescriptor(REAL.gustoNet, null)).toBe("GUSTO");
  });

  // The rule key is derived by normalizeCounterparty, so the feed's "Gusto" and
  // the descriptor's "GUSTO" have to land on one rule, not two.
  it("the feed's casing and the descriptor's resolve to the same rule key", () => {
    expect(normalizeCounterparty("GUSTO")).toBe(normalizeCounterparty("Gusto"));
    expect(normalizeCounterparty(counterpartyFromDescriptor(REAL.square, "Square")))
      .toBe(normalizeCounterparty("Square"));
  });

  it("names a counterparty for every Chase shape except cheques and wires", () => {
    const unnamed = Object.entries(REAL)
      .filter(([, d]) => counterpartyFromDescriptor(d) === null)
      .map(([k]) => k);
    expect(unnamed.sort()).toEqual(["businessBanking", "check", "wire"]);
  });
});
