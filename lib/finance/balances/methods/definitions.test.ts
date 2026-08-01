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
import { getMethod, listMethods, stepKey, type MethodKind } from "./registry";
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
    for (const key of ["salesTaxPayable", "undistributedTips", "accountsReceivable"]) {
      const steps = getMethod(key)!.steps.map(stepKey);
      expect(steps, key).toContain("transactionPostings");
      expect(steps.length, key).toBe(2);
    }
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

  it("labels and summaries are sentence case, never title case", () => {
    for (const m of listMethods()) {
      const words = m.label.split(" ").slice(1);
      const titled = words.filter((w) => /^[A-Z][a-z]/.test(w) && w !== "Square" && w !== "Ramp" && w !== "Plaid");
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

  it("is what decides whether an account raises a month-end close task", () => {
    // The rule closeTasks.ts now applies. Manual entry and the Square balance
    // both need a human figure; nothing else does, and a method gaining one by
    // accident would start emailing about an account nobody has to touch.
    const needing = listMethods()
      .filter((m) => (m.setup ?? []).some((f) => f.kind === "operatorBalance"))
      .map((m) => m.key)
      .sort();
    expect(needing).toEqual(["manualBalance", "squareStoredBalance"]);
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
      const coa = { statementSection: sections[account] } as never;
      const offerable = !method.appliesTo || method.appliesTo(coa);
      expect(offerable, `${methodKey} is not offerable to account ${account}`).toBe(true);
    }
  });
});
