import { describe, it, expect } from "vitest";
import {
  FLOW_TYPES,
  FLOW_GROUPS,
  flowTypesInGroup,
  getFlowType,
  isFlowType,
  flowNeedsAccount,
  flowAffectsPl,
  OUT_OF_BOOKS,
  TREATMENT_GROUPS,
  TREATMENT_OPTIONS,
  treatmentsInGroup,
  getTreatment,
  treatmentNeedsAccount,
} from "./flowTypes";
import { affectsPlForFlowType } from "./bankLedger";

describe("flow type registry", () => {
  it("every flow belongs to a declared group, and every group has flows", () => {
    for (const f of FLOW_TYPES) expect(FLOW_GROUPS).toContain(f.group);
    for (const g of FLOW_GROUPS) expect(flowTypesInGroup(g).length).toBeGreaterThan(0);
  });

  it("keys are unique — a duplicate would shadow a flow in the lookup map", () => {
    expect(new Set(FLOW_TYPES.map((f) => f.key)).size).toBe(FLOW_TYPES.length);
  });

  it("every flow states a consequence, because the picker renders it verbatim", () => {
    for (const f of FLOW_TYPES) {
      expect(f.effect.trim().length).toBeGreaterThan(0);
      expect(f.label.trim().length).toBeGreaterThan(0);
      expect(f.phrase.trim().length).toBeGreaterThan(0);
    }
  });

  // The invariant the old code broke: a flow that reaches the P&L must have an
  // account to reach it UNDER. `affects_pl` without `needs_account` is a row the
  // statements count and cannot attribute.
  it("anything that counts on the P&L needs an account", () => {
    for (const f of FLOW_TYPES) if (f.affectsPl) expect(f.needsAccount).toBe(true);
  });

  it("counts operating expenses on the P&L — the bug this registry closes", () => {
    expect(flowAffectsPl("operating_expense")).toBe(true);
    expect(affectsPlForFlowType("operating_expense")).toBe(true);
  });

  it("bankLedger's affectsPlForFlowType and the registry cannot disagree", () => {
    for (const f of FLOW_TYPES) expect(affectsPlForFlowType(f.key)).toBe(f.affectsPl);
  });

  it("nothing outside the P&L group affects the P&L", () => {
    for (const f of FLOW_TYPES) {
      expect(f.affectsPl).toBe(f.group === "Counts on the P&L");
    }
  });

  it("settlements, transfers and unclassified rows never carry an account", () => {
    for (const key of ["card_settlement", "bill_settlement", "deposit", "internal_transfer", "unclassified"]) {
      expect(flowNeedsAccount(key)).toBe(false);
    }
  });

  it("balance sheet movement needs an account without touching the P&L", () => {
    expect(flowNeedsAccount("balance_sheet_movement")).toBe(true);
    expect(flowAffectsPl("balance_sheet_movement")).toBe(false);
  });

  // An unrecognised value means "a newer deploy invented this" or "a rollback
  // removed it". Both must fail closed: never counted, never given an account.
  it("an unknown flow is rejected and claims nothing", () => {
    expect(isFlowType("interest_income")).toBe(false);   // the pre-migration name
    expect(getFlowType("nonsense")).toBeNull();
    expect(flowNeedsAccount("nonsense")).toBe(false);
    expect(flowAffectsPl("nonsense")).toBe(false);
    expect(flowNeedsAccount(null)).toBe(false);
  });
});

describe("the settings picker's vocabulary", () => {
  it("offers every flow except unclassified, plus out-of-books", () => {
    expect(TREATMENT_OPTIONS.map((t) => t.value).sort()).toEqual(
      [...FLOW_TYPES.map((f) => f.key).filter((k) => k !== "unclassified"), OUT_OF_BOOKS].sort(),
    );
  });

  // A rule whose conclusion is "somebody should look at this" is the same as
  // having no rule; the picker's empty option says that instead.
  it("never offers unclassified as a standing rule", () => {
    expect(getTreatment("unclassified")).toBeNull();
    expect(treatmentNeedsAccount("unclassified")).toBe(false);
  });

  // The load-bearing guard: out_of_books is an answer the picker offers but NOT
  // a flow type. It belongs in bank_ledger_gl_rules, and anything that checks
  // before storing on bank_ledger.flow_type has to reject it.
  it("out-of-books is offered but can never be stored as a flow", () => {
    expect(getTreatment(OUT_OF_BOOKS)).not.toBeNull();
    expect(isFlowType(OUT_OF_BOOKS)).toBe(false);
    expect(getFlowType(OUT_OF_BOOKS)).toBeNull();
    expect(flowNeedsAccount(OUT_OF_BOOKS)).toBe(false);
    expect(flowAffectsPl(OUT_OF_BOOKS)).toBe(false);
  });

  it("every option belongs to a declared group, and every group has options", () => {
    for (const t of TREATMENT_OPTIONS) expect(TREATMENT_GROUPS).toContain(t.group);
    for (const g of TREATMENT_GROUPS) expect(treatmentsInGroup(g).length).toBeGreaterThan(0);
  });

  // The panel renders step 2 and 3 from this alone, so it must agree with the
  // flow registry for every value that exists in both.
  it("agrees with the flow registry on whether an account is used", () => {
    for (const f of FLOW_TYPES) {
      if (f.key === "unclassified") continue;
      expect(treatmentNeedsAccount(f.key)).toBe(f.needsAccount);
    }
  });

  // "Leave for review" and an unknown value both mean the account question is
  // not asked yet — never that it is asked with nothing to show.
  it("no answer, and an unknown answer, both ask for no account", () => {
    expect(treatmentNeedsAccount("")).toBe(false);
    expect(treatmentNeedsAccount(null)).toBe(false);
    expect(treatmentNeedsAccount("nonsense")).toBe(false);
  });
});
