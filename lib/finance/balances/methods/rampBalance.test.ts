/**
 * Declaration-level guards for the Ramp balance method.
 *
 * definitions.test.ts already enforces the shared conformance rules (every step
 * resolves, copy is readable, no key collisions). What is asserted here is what
 * only this method can get wrong: losing its connection declaration, being
 * offered on the wrong kind of account, or growing a second step.
 */
import { describe, it, expect } from "vitest";
import "./index";
import { getMethod, stepKey, connectionProviderOf, connectionFieldOf } from "./registry";
import type { CoaAccountRef } from "../../financials/types";

const method = () => getMethod("rampBalance")!;
const coa = (statementSection: string) => ({ statementSection }) as CoaAccountRef;

describe("Ramp account balance method", () => {
  it("is registered and declares Ramp as its connection provider", () => {
    // This one field is what makes the setup panel, connection resolution and
    // the health line all work. Dropping it silently strands the account with
    // no way to link it.
    expect(connectionProviderOf(method())).toBe("ramp");
  });

  it("connects by listing accounts rather than by signing in", () => {
    // Ramp authenticates from app-level credentials that already exist, so
    // there is nothing for an operator to sign in to. Declaring "authorize"
    // here would make the panel wait for a handshake that never comes.
    expect(connectionFieldOf(method())?.connect).toBe("discover");
  });

  it("needs no figure from a person", () => {
    // Ramp reports the closing balance itself. An operatorBalance field would
    // raise a month-end close task for an account that does not need one.
    expect(method().setup?.some((f) => f.kind === "operatorBalance")).toBe(false);
  });

  it("stores its contribution under the provider key", () => {
    // gl_account_balances.contributions is keyed by this string. Renaming it
    // later orphans history rather than failing, so pin it now.
    expect(method().steps.map(stepKey)).toEqual(["rampBalance"]);
  });

  it("stays a single step", () => {
    // Unlike the accrual pairs, Ramp reports the account's actual closing
    // balance. A postings step alongside it would double-count every Ramp
    // movement the reported balance already includes.
    expect(method().steps).toHaveLength(1);
  });

  it("is offered on bank accounts and nowhere else", () => {
    const appliesTo = method().appliesTo!;
    expect(appliesTo(coa("bank"))).toBe(true);
    for (const section of ["ar", "equity", "other_current_liabilities", "credit_card", "fixed_assets"]) {
      expect(appliesTo(coa(section)), `offered on ${section}`).toBe(false);
    }
  });

  it("tells the operator the figure is an available balance", () => {
    // The one thing a bookkeeper reconciling against a statement needs to know:
    // a pending payment on the last day makes the two disagree legitimately.
    expect(method().steps[0].description.toLowerCase()).toContain("available balance");
  });
});
