import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EM_DASH, formatBalanceCents } from "@/lib/format";

/**
 * Guards the one rule this screen cannot express in its own types: a balance of
 * exactly zero must never render as the em-dash sentinel.
 *
 * The screen shows two kinds of blank. "No row" means no balance could be
 * worked out — the account is unsourced, or the month has not closed — and that
 * is what the em dash says. "Zero" means the calculation ran and the answer was
 * nothing, which is a finding. `formatCurrencyCents` blanks an exact zero on
 * purpose (a page of `$0.00` lines is the noise it was written to remove on the
 * P&L, cash-flow and tax statements), so using it here collapses the two into
 * the same glyph — the "null, not zero" rule of
 * docs/finance/balance-methods-handoff.md §4 failing at the display rather than
 * in the data. `formatBalanceCents` is the same formatter with `$0.00` at zero.
 *
 * These are source assertions, not render assertions: vitest runs in `node`
 * with no DOM and the repo has no component-test harness, so there is no way to
 * mount a "use client" page here. Same approach as
 * lib/auth/__tests__/rlsGrantParity.test.ts, which pins a SQL/TS coupling it
 * likewise cannot execute. If a component harness ever lands, replace the scan
 * with a render of an account whose `liveBalance.cents` is 0.
 */

const DIR = join(process.cwd(), "app", "settings", "finance", "balance-sheet-accounts");

/** Every file on this screen that puts a computed figure on the page. */
const SCREEN_FILES = ["page.tsx", "MethodSetupPanel.tsx"];

/**
 * Source with comments removed, so the scan below reads code and not prose —
 * the call sites carry comments that name `formatCurrencyCents` in order to
 * explain why it is the wrong formatter here, and those must not read as uses
 * of it. Stripping block comments covers JSDoc and braced JSX comments alike;
 * line comments are only stripped when the `//` opens the line, so a mid-line
 * URL survives.
 */
function code(file: string): string {
  return readFileSync(join(DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the zero balance itself", () => {
  it("is a real answer, not a blank", () => {
    expect(formatBalanceCents(0)).toBe("$0.00");
    expect(formatBalanceCents(0)).not.toBe(EM_DASH);
  });

  it("still reads as a blank when nothing was determined", () => {
    expect(formatBalanceCents(null)).toBe(EM_DASH);
  });
});

describe.each(SCREEN_FILES)("%s", (file) => {
  it("renders money through formatBalanceCents only", () => {
    const source = code(file);
    // Any `format<Something>Cents(` / `formatCurrency(` call site. The callee is
    // captured so the failure names the formatter that crept in.
    const callees = [...source.matchAll(/\bformat(?:Currency|Balance|UnitCost)\w*\s*\(/g)].map((m) =>
      m[0].replace(/\s*\($/, ""),
    );

    expect(callees.length).toBeGreaterThan(0);
    expect([...new Set(callees)]).toEqual(["formatBalanceCents"]);
  });

  it("does not import a formatter that blanks zero", () => {
    const source = code(file);
    expect(source).not.toMatch(/\bformatCurrencyCents\b/);
    expect(source).not.toMatch(/\bformatCurrency\b/);
  });
});
