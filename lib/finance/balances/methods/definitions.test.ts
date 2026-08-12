/**
 * Conformance suite every built-in method must pass.
 *
 * Two jobs. First, structural: a method whose step names a provider that does
 * not exist fails only at snapshot time, in a cron, as a skipped account -- so
 * it is caught here instead. Second, editorial: the explainer panel is only
 * worth building if its copy is genuinely readable by someone who does not know
 * the schema, and "someone will review the wording" is not a control. These
 * assertions are.
 */
import { describe, it, expect } from "vitest";
import "./index";
import {
  CLOSE_DUE_DAYS_KEY,
  getMethod,
  listMethods,
  methodsFor,
  requiresMonthEndBalance,
  stepKey,
  type MethodKind,
} from "./registry";
import { getProvider } from "../registry";
import { GOLDEN_BALANCE_SHEET, GOLDEN_STEP_KEYS } from "../__fixtures__/goldenBalanceSheet";

/**
 * The method each golden account is migrated to. Read alongside the migration
 * that rewrites balance_sheet_account_sources -- if the two disagree, the
 * accounts silently lose their source on deploy.
 */
const ACCOUNT_METHOD: Record<string, string> = {
  "1100": "accountsReceivable",
  "1310": "transactionPostings",
  "2220": "salesTaxPayable",
  "2230": "transactionPostings",
  "2250": "salesTaxPayable",
  "2310": "undistributedTips",
  "2420": "transactionPostings",
  "3300": "retainedEarnings",
};

describe("built-in method definitions", () => {
  it("registers the six built-in methods", () => {
    // Containment, not equality. Integration methods land on separate branches
    // (Ramp, Plaid, Square) and an exact list would mean the first one merged
    // breaks the other two for a reason unrelated to their own work.
    const keys = listMethods().map((m) => m.key);
    for (const expected of [
      "accountsPayable",
      "accountsReceivable",
      "manualBalance",
      "retainedEarnings",
      "salesTaxPayable",
      "transactionPostings",
      "undistributedTips",
    ]) {
      expect(keys, `built-in method "${expected}" is missing`).toContain(expected);
    }
  });

  it("registers no duplicate method keys", () => {
    const keys = listMethods().map((m) => m.key);
    expect(new Set(keys).size, "two methods share a key").toBe(keys.length);
  });

  it("covers all three dropdown options", () => {
    const kinds = new Set<MethodKind>(listMethods().map((m) => m.kind));
    expect([...kinds].sort()).toEqual(["calculation", "manual", "postings"]);
  });

  it("every declared step resolves to a registered provider", () => {
    for (const m of listMethods()) {
      for (const step of m.steps) {
        expect(getProvider(step.providerKey), `${m.key}.${stepKey(step)} -> ${step.providerKey}`).toBeDefined();
      }
    }
  });

  it("keeps manual entry and transaction postings as single-step methods", () => {
    // These two ARE the other two dropdown options; a composite hiding behind
    // either would make the three-way selector a lie.
    expect(getMethod("manualBalance")!.steps).toHaveLength(1);
    expect(getMethod("transactionPostings")!.steps).toHaveLength(1);
  });

  it("pairs every accrual with its settling postings step", () => {
    // The whole reason this layer exists. An accrual-only method would let a
    // user reach the exact state that overstated GL 2310 eightfold.
    // Step counts are explicit rather than a blanket 2: GL 2220 accrues two
    // different taxes to one agency, and "exactly two steps" would have blocked
    // the step whose absence made that account read as overpaid.
    const expectedSteps: Record<string, number> = {
      salesTaxPayable: 2,
      ncDorTaxPayable: 3,
      ttbExcisePayable: 2,
      undistributedTips: 2,
      accountsReceivable: 2,
      accountsPayable: 2,
    };
    for (const [key, count] of Object.entries(expectedSteps)) {
      const steps = getMethod(key)!.steps.map(stepKey);
      expect(steps, key).toContain("transactionPostings");
      expect(steps.length, key).toBe(count);
    }
  });

  /**
   * Receivables and payables are opposite sides of the same idea and their
   * sections differ by one letter, so an appliesTo pointed at the wrong one
   * would offer a user "what customers owe you" on the account for what they owe
   * suppliers -- a plausible-looking choice producing a balance of the wrong
   * sign on the wrong side of the sheet.
   */
  it("keeps receivables and payables offered to their own side of the sheet", () => {
    const ar = { statementSection: "ar" } as never;
    const ap = { statementSection: "ap" } as never;

    expect(methodsFor(ap).map((m) => m.key)).toContain("accountsPayable");
    expect(methodsFor(ar).map((m) => m.key)).not.toContain("accountsPayable");
    expect(methodsFor(ar).map((m) => m.key)).toContain("accountsReceivable");
    expect(methodsFor(ap).map((m) => m.key)).not.toContain("accountsReceivable");
  });
});

describe("explainer copy is readable by a non-technical operator", () => {
  const allSteps = listMethods().flatMap((m) => m.steps.map((s) => ({ method: m.key, step: s })));

  it("every method has a summary sentence", () => {
    for (const m of listMethods()) {
      expect(m.summary.length, m.key).toBeGreaterThan(20);
      expect(m.summary.endsWith("."), `${m.key} summary must end in a period`).toBe(true);
    }
  });

  it("every step has a label, source and full-sentence description", () => {
    for (const { method, step } of allSteps) {
      const id = `${method}.${stepKey(step)}`;
      expect(step.label.length, `${id} label`).toBeGreaterThan(3);
      expect(step.source.length, `${id} source`).toBeGreaterThan(5);
      expect(step.description.length, `${id} description`).toBeGreaterThan(40);
      expect(step.description.endsWith("."), `${id} description must end in a period`).toBe(true);
    }
  });

  it("no description leaks a code identifier, table name or provider key", () => {
    const providerKeys = listMethods().flatMap((m) => m.steps.map((s) => s.providerKey));
    for (const { method, step } of allSteps) {
      const prose = `${step.label} ${step.description} ${step.source}`;
      const id = `${method}.${stepKey(step)}`;
      expect(prose, `${id} contains a snake_case identifier`).not.toMatch(/[a-z]+_[a-z]+/);
      expect(prose, `${id} contains a code call`).not.toMatch(/\(\)|=>|\{|\}/);
      for (const key of providerKeys) {
        expect(prose.includes(key), `${id} names the provider key "${key}" in prose`).toBe(false);
      }
    }
  });

  /**
   * Capitalised words that are NOT title casing — they are names, and
   * lower-casing them would be wrong rather than plainer.
   *
   * Enumerated rather than inferred: a rule like "allow any capitalised word"
   * would let real title casing straight through, which is the thing this
   * assertion exists to catch. Adding a word here is a deliberate act, and the
   * list is short enough to read.
   *
   * Square / Ramp / Plaid are the integrations. Department / Revenue are the
   * NC Department of Revenue, whose account is named for the agency rather
   * than for a tax, because it collects more than one.
   */
  const PROPER_NOUNS = new Set(["Square", "Ramp", "Plaid", "Department", "Revenue"]);

  it("labels and summaries are sentence case, never title case", () => {
    for (const m of listMethods()) {
      const words = m.label.split(" ").slice(1);
      const titled = words.filter((w) => /^[A-Z][a-z]/.test(w) && !PROPER_NOUNS.has(w));
      expect(titled, `${m.key} label "${m.label}" looks title cased`).toEqual([]);
    }
  });

  /**
   * Setup copy is held to the same standard as step copy, and for a stronger
   * reason: a step description is read by someone checking a number they already
   * have, while this is read by someone who is STUCK. It is the sentence that
   * has to explain why an account is blank.
   */
  it("every setup field has a full-sentence explanation in plain English", () => {
    const allFields = listMethods().flatMap((m) => (m.setup ?? []).map((f) => ({ method: m.key, field: f })));
    const providerKeys = listMethods().flatMap((m) => m.steps.map((s) => s.providerKey));

    for (const { method, field } of allFields) {
      const id = `${method}.${field.key}`;
      expect(field.label.length, `${id} label`).toBeGreaterThan(3);
      expect(field.help.length, `${id} help`).toBeGreaterThan(40);
      expect(field.help.endsWith("."), `${id} help must end in a period`).toBe(true);

      const prose = `${field.label} ${field.help}`;
      expect(prose, `${id} contains a snake_case identifier`).not.toMatch(/[a-z]+_[a-z]+/);
      expect(prose, `${id} contains a code call`).not.toMatch(/\(\)|=>|\{|\}/);
      for (const key of providerKeys) {
        expect(prose.includes(key), `${id} names the provider key "${key}" in prose`).toBe(false);
      }
    }
  });

  /**
   * Held to the standard above and then one further, for the kinds whose whole
   * job is to name a THING the reader has to go and find.
   *
   * A picker with a vague label is worse than a missing field: it offers a list
   * of real people, or a real number of days, and gives no way to tell which
   * answer is the right one. Setup copy is the only explanation a bookkeeper
   * gets, and these two kinds are the ones where a wrong answer looks
   * completely configured.
   */
  it("says who or what a picker is asking for, in the field's own words", () => {
    for (const m of listMethods()) {
      for (const field of m.setup ?? []) {
        if (field.kind !== "user" && field.kind !== "account") continue;
        const id = `${m.key}.${field.key}`;
        // Naming a person or an account has consequences a reader cannot see
        // from the picker -- an alert goes somewhere, a balance is read from
        // somewhere -- so the help has to say what those are.
        expect(field.help.length, `${id} help must explain what naming this does`).toBeGreaterThan(60);
        expect(field.label.toLowerCase(), `${id} label must not be bare "user"`).not.toBe("user");
      }
    }
  });

  it("gives every number field a unit, so nobody has to guess what 10 means", () => {
    // "10" is ten days, ten months, ten percent or ten dollars depending on a
    // property that is not on screen. The unit drives how the input renders,
    // and an unset one silently falls back to a bare number.
    for (const m of listMethods()) {
      for (const field of m.setup ?? []) {
        if (field.kind === "number") expect(field.unit, `${m.key}.${field.key}`).toBeDefined();
      }
    }
  });
});

describe("setup declarations", () => {
  it("declares a connect flow on every connection field", () => {
    // Without it the panel cannot tell "ask the server for a list" from "send
    // the operator to sign in", and would either fetch with no credential or
    // wait for a handshake that never comes.
    for (const m of listMethods()) {
      for (const field of m.setup ?? []) {
        if (field.kind === "connection") {
          expect(["discover", "authorize"], `${m.key}.${field.key}`).toContain(field.connect);
        }
      }
    }
  });

  it("stores every connection under the key the resolver actually reads", () => {
    // resolveConnection, planCaptures and the health line all read
    // config.connectionId by name. A field storing it anywhere else would
    // configure an account that then computes nothing, with no error anywhere.
    for (const m of listMethods()) {
      for (const field of m.setup ?? []) {
        if (field.kind === "connection") expect(field.key, m.key).toBe("connectionId");
      }
    }
  });

  /**
   * The rule closeTasks.ts applies, asserted against the declarations
   * themselves.
   *
   * This assertion once read `(m.setup ?? []).some((f) => f.kind ===
   * "operatorBalance")`, and it caught the exact regression it was written for:
   * manual entry's setup was redesigned to name a responsible person instead of
   * taking a dollar figure, the operatorBalance field went away, and this test
   * failed with only Square left. Without the derivation moving to the steps,
   * every manual account would have gone unchased in silence -- no task, no
   * alert, no error. Both methods, and only these two, need a person's figure
   * every month.
   */
  it("is what decides whether an account raises a month-end close task", () => {
    const needing = listMethods().filter(requiresMonthEndBalance).map((m) => m.key).sort();
    expect(needing).toEqual(["manualBalance", "squareStoredBalance"]);
  });

  it("derives that from the steps, not from a setup field", () => {
    // The two questions are genuinely different and used to be conflated.
    // `operatorBalance` means "ask a person ONCE, at setup" -- Square's anchor,
    // which has nowhere else to come from. Needing a figure EVERY month is a
    // property of what the calculation reads. Manual entry is now the case that
    // proves they are not the same question.
    const manual = getMethod("manualBalance")!;
    expect(manual.setup!.some((f) => f.kind === "operatorBalance")).toBe(false);
    expect(requiresMonthEndBalance(manual)).toBe(true);
  });

  it("keeps the Square anchor asking for a figure at setup", () => {
    // Square is the one method for which a dollar input on the Settings screen
    // is correct: it publishes no running balance, so the calculation cannot
    // start without a figure a person has confirmed. Removing manual entry's
    // must not have taken this one with it.
    const square = getMethod("squareStoredBalance")!;
    expect(square.setup!.some((f) => f.kind === "operatorBalance")).toBe(true);
  });

  it("asks manual entry for a responsible person and nothing priced in dollars", () => {
    // Settings holds rules, Transactions holds values. Entering the balance is
    // the recurring monthly job, not a setup step, and putting an amount box
    // here is what made the two screens confusable in the first place.
    const setup = getMethod("manualBalance")!.setup!;
    expect(setup.map((f) => f.kind).sort()).toEqual(["number", "user"]);
    expect(setup.find((f) => f.kind === "user")!.optional).toBeUndefined();
  });

  it("stores any per-account close deadline under the key closeTasks reads", () => {
    // Same arrangement as connectionId: one reserved key, so the reader and the
    // declaration cannot drift. A deadline saved anywhere else would configure
    // an account that then silently keeps the global due date.
    for (const m of listMethods()) {
      const field = (m.setup ?? []).find((f) => f.key === CLOSE_DUE_DAYS_KEY);
      if (!field) continue;
      expect(field.kind, m.key).toBe("number");
      if (field.kind === "number") expect(field.unit, m.key).toBe("days");
      // Required would mean an account is unconfigured until it repeats a
      // deadline the business has already set once.
      expect(field.optional, m.key).toBe(true);
    }
  });

  it("keeps the Square sweep destination optional and restricted to bank accounts", () => {
    // Optional even now that squareDrift.ts reads it. An account that does not
    // name a destination still reconciles -- it just gets one undifferentiated
    // difference instead of a split one, which is exactly the behaviour that
    // existed before the bank feed. Requiring it would turn a working account
    // into an unconfigured one over an improvement it can live without.
    //
    // Restricted to bank accounts because it names where cash physically lands.
    // An unfiltered picker would offer expense and equity accounts, where the
    // choice is meaningless but would still read as configured.
    const field = getMethod("squareStoredBalance")!.setup!.find((f) => f.key === "sweepDestinationCoaId");
    expect(field, "the Square method must declare where its payouts land").toBeDefined();
    expect(field!.kind).toBe("account");
    expect(field!.optional).toBe(true);
    if (field!.kind === "account") expect(field!.sections).toEqual(["bank"]);
  });
});

describe("parity with the frozen production capture", () => {
  it("maps every golden account to a method", () => {
    const golden = new Set(
      Object.values(GOLDEN_BALANCE_SHEET).flatMap((rows) => rows.map((r) => r.accountNumber)),
    );
    for (const account of golden) {
      expect(ACCOUNT_METHOD[account], `account ${account} has no method mapping`).toBeDefined();
    }
  });

  it("each account's method can produce exactly the contribution keys it already has", () => {
    // Subset rather than equality on purpose: a step legitimately returns null
    // in a month with no activity, which is why June 2250 carries only its
    // accrual. What must never happen is a golden key the method cannot emit --
    // that would orphan a historical contribution.
    for (const [periodEnd, rows] of Object.entries(GOLDEN_BALANCE_SHEET)) {
      for (const row of rows) {
        const method = getMethod(ACCOUNT_METHOD[row.accountNumber])!;
        const emits = new Set(method.steps.map(stepKey));
        for (const key of Object.keys(row.contributions)) {
          expect(
            emits.has(key),
            `${periodEnd} ${row.accountNumber} (${method.key}) cannot emit historical contribution "${key}"`,
          ).toBe(true);
        }
      }
    }
  });

  it("introduces no new step key on a method a historical account uses", () => {
    // Scoped to the mapped methods on purpose. The frozen set constrains what
    // can appear in gl_account_balances.contributions for accounts that ALREADY
    // have history; a method no historical account uses -- manual entry, and
    // every integration still to come -- is free to define its own keys.
    const allowed = new Set<string>(GOLDEN_STEP_KEYS);
    for (const methodKey of new Set(Object.values(ACCOUNT_METHOD))) {
      for (const step of getMethod(methodKey)!.steps) {
        expect(allowed.has(stepKey(step)), `new step key "${stepKey(step)}" in ${methodKey}`).toBe(true);
      }
    }
  });

  it("offers each golden account's method to that account's section", () => {
    const sections: Record<string, string> = {
      "1100": "ar",
      "1310": "other_current_assets",
      "2220": "other_current_liabilities",
      "2230": "other_current_liabilities",
      "2250": "other_current_liabilities",
      "2310": "other_current_liabilities",
      "2420": "other_current_liabilities",
      "3300": "equity",
    };
    for (const [account, methodKey] of Object.entries(ACCOUNT_METHOD)) {
      const method = getMethod(methodKey)!;
      // accountNumber is supplied as well as the section: a method may narrow
      // itself to specific accounts (sales tax payable does, to the two the
      // Square tax mapping actually names), and a section-only stub would fail
      // every such predicate here for the wrong reason.
      const coa = { accountNumber: account, statementSection: sections[account] } as never;
      const offerable = !method.appliesTo || method.appliesTo(coa);
      expect(offerable, `${methodKey} is not offerable to account ${account}`).toBe(true);
    }
  });
});
