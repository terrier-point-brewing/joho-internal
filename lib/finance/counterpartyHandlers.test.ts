import { describe, it, expect } from "vitest";
import {
  COUNTERPARTY_HANDLERS,
  SELECTABLE_HANDLERS,
  getCounterpartyHandler,
  isSelectableHandler,
  codesFromRuleAccount,
  SINGLE_ACCOUNT,
  BALANCE_SHEET,
} from "./counterpartyHandlers";

describe("the handler registry", () => {
  it("keeps every key distinct — a duplicate would silently re-route a counterparty", () => {
    const keys = COUNTERPARTY_HANDLERS.map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every handler that is not the default something to say and somewhere to go", () => {
    // The pill replaces the account picker, so a handler with no badge leaves an
    // empty cell where the operator expects to see what is happening instead.
    for (const handler of COUNTERPARTY_HANDLERS) {
      if (handler.glEffect === "account") continue;
      expect(handler.badge, handler.key).not.toBe("");
      expect(handler.manageHref, handler.key).not.toBe("");
    }
  });

  it("still carries the two modes that existed before the registry, unchanged", () => {
    // Every stored row holds one of these. Renaming or re-behaving either would
    // re-route live counterparties with no migration to notice it.
    expect(codesFromRuleAccount(SINGLE_ACCOUNT)).toBe(true);
    expect(codesFromRuleAccount("payroll_split")).toBe(false);
    expect(isSelectableHandler(SINGLE_ACCOUNT)).toBe(true);
    expect(isSelectableHandler("payroll_split")).toBe(true);
  });
});

describe("what may be chosen versus what may only be claimed", () => {
  it("keeps the balance-sheet handler out of the dropdown", () => {
    // Asking an operator to pick this would be asking for a fact GL 1040's
    // setup already states, in a second place, with nothing keeping the two
    // agreed.
    expect(SELECTABLE_HANDLERS.map((h) => h.key)).not.toContain(BALANCE_SHEET);
    expect(isSelectableHandler(BALANCE_SHEET)).toBe(false);
  });

  it("still recognises a claim-only handler when asked about it directly", () => {
    // Not selectable is not the same as not real: the panel resolves the badge
    // for a claimed row through exactly this lookup.
    expect(getCounterpartyHandler(BALANCE_SHEET)?.glEffect).toBe("elsewhere");
  });
});

describe("an unrecognised routing value", () => {
  it("does not code the expense from the rule's account", () => {
    // A handler removed in a rollback, or a row written by a newer deploy. The
    // safe reading is "somebody else was supposed to handle this" — which
    // surfaces it for a human — not "code it to whatever account is sitting on
    // the row".
    expect(codesFromRuleAccount("some_future_handler")).toBe(false);
    expect(getCounterpartyHandler("some_future_handler")).toBeNull();
  });

  it("cannot be written through the API", () => {
    expect(isSelectableHandler("some_future_handler")).toBe(false);
  });

  it("treats null and undefined as unrecognised rather than as the default", () => {
    expect(codesFromRuleAccount(null)).toBe(false);
    expect(codesFromRuleAccount(undefined)).toBe(false);
  });
});
