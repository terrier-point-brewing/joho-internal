/**
 * Declaration-level guards for the Plaid bank balance method.
 *
 * definitions.test.ts already enforces the shared conformance rules (every step
 * resolves, copy is readable, no key collisions), and rampBalance.test.ts does
 * the same job for Ramp. What is asserted here is what only this method can get
 * wrong: losing its connection declaration, being offered on the wrong kind of
 * account, growing a second step, or dropping the one sentence that tells an
 * operator why a month can legitimately come back blank.
 */
import { describe, it, expect } from "vitest";
import "./index";
import { getMethod, stepKey, connectionProviderOf, connectionFieldOf } from "./registry";
import type { CoaAccountRef } from "../../financials/types";

const method = () => getMethod("plaidBankBalance")!;
const coa = (statementSection: string) => ({ statementSection }) as CoaAccountRef;

describe("Plaid bank balance method", () => {
  it("is registered and declares Plaid as its connection provider", () => {
    // This one field is what makes the setup panel, connection resolution and
    // the health line all work, and it is also what the capture cron plans off.
    // Dropping it strands the account AND silently stops the daily read.
    expect(connectionProviderOf(method())).toBe("plaid");
  });

  it("connects by signing in at the bank, not by listing accounts", () => {
    // The one flow of the three that cannot be a plain list: no candidate
    // exists until the operator has authenticated at their own bank. Declaring
    // "discover" here would make the panel ask the server for accounts it has
    // no credential to fetch.
    expect(connectionFieldOf(method())?.connect).toBe("authorize");
  });

  it("stores its contribution under the provider key", () => {
    // gl_account_balances.contributions is keyed by this string. Renaming it
    // later orphans history rather than failing, so pin it now.
    expect(method().steps.map(stepKey)).toEqual(["plaidBalance"]);
  });

  it("stays a single step", () => {
    // The bank's own balance already reflects every posted movement. A postings
    // step alongside it would count the same money twice.
    expect(method().steps).toHaveLength(1);
  });

  it("is offered on bank accounts and nowhere else", () => {
    const appliesTo = method().appliesTo!;
    expect(appliesTo(coa("bank"))).toBe(true);
    for (const section of ["ar", "equity", "other_current_liabilities", "credit_card", "fixed_assets"]) {
      expect(appliesTo(coa(section)), `offered on ${section}`).toBe(false);
    }
  });

  it("does not collide with the Ramp method, which is offered on the same accounts", () => {
    // Both apply to bank-section accounts, so a GL 1020/1030 dropdown shows
    // both. They must remain separately selectable rather than one shadowing
    // the other.
    expect(method().key).not.toBe(getMethod("rampBalance")!.key);
    expect(stepKey(method().steps[0])).not.toBe(stepKey(getMethod("rampBalance")!.steps[0]));
  });

  it("warns the operator that a month with no reading stays blank", () => {
    // The single most surprising behaviour of this method, and the one thing a
    // bookkeeper must not discover by finding an empty cell at close.
    expect(method().steps[0].description.toLowerCase()).toContain("blank");
  });
});
