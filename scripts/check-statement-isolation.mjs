#!/usr/bin/env node
/**
 * Guards the boundary between the balance sheet and every other Finance tab.
 *
 * The P&L, cash-flow and transactions paths are settled and verified. The
 * balance sheet is under active development -- methods, integrations,
 * month-end close -- and that work must not be able to reach the modules the
 * other tabs are built on.
 *
 * The rule is one-directional and deliberately so:
 *
 *   balances/*  ->  financials/*      ALLOWED. transactionPostings genuinely
 *                                     needs normalizeSign, and retainedEarnings
 *                                     needs aggregateRows, precisely so those
 *                                     figures cannot drift from the P&L.
 *
 *   financials/* (frozen list) -> balances/*   FORBIDDEN. An import in this
 *                                     direction is how balance-sheet work
 *                                     starts being able to change what the P&L
 *                                     renders.
 *
 * buildBalanceSheetFinancials.ts is the single sanctioned bridge and is not on
 * the frozen list.
 *
 * Run: node scripts/check-statement-isolation.mjs
 */
import { readFileSync, existsSync } from "node:fs";

/**
 * Modules the P&L, cash-flow and transactions tabs are built on. None of these
 * may import from lib/finance/balances. Add to this list when a module becomes
 * load-bearing for a verified tab; never remove from it to make a build pass.
 */
const FROZEN = [
  "lib/finance/financials/buildFinancials.ts",
  "lib/finance/financials/aggregateRows.ts",
  "lib/finance/financials/fetchSources.ts",
  "lib/finance/financials/normalizeSign.ts",
  "lib/finance/financials/summaries.ts",
  "lib/finance/financials/manualNetSales.ts",
  "lib/finance/financials/manualAdjustment.ts",
  "lib/finance/financials/statementCommon.ts",
  "lib/finance/financials/types.ts",
  "lib/finance/financials/volume.ts",
];

/** The one module allowed to bridge the two worlds. */
const BRIDGE = "lib/finance/financials/buildBalanceSheetFinancials.ts";

/** Matches a real import/export-from of the balances tree, not a mention in prose. */
const BALANCES_IMPORT =
  /^\s*(?:import|export)[\s\S]*?from\s+["'](?:@\/lib\/finance\/balances|\.\.\/balances|\.\/balances)[^"']*["']/gm;

/** Bare side-effect import: `import "@/lib/finance/balances/providers";` */
const BALANCES_SIDE_EFFECT = /^\s*import\s+["'](?:@\/lib\/finance\/balances|\.\.\/balances)[^"']*["']/gm;

const failures = [];

for (const file of FROZEN) {
  if (!existsSync(file)) {
    failures.push(`${file}: listed as frozen but does not exist — update FROZEN or restore the file`);
    continue;
  }
  const src = readFileSync(file, "utf8");
  const hits = [...src.matchAll(BALANCES_IMPORT), ...src.matchAll(BALANCES_SIDE_EFFECT)];
  for (const hit of hits) {
    const line = src.slice(0, hit.index).split("\n").length;
    failures.push(`${file}:${line} imports from lib/finance/balances — route it through ${BRIDGE} instead`);
  }
}

if (!existsSync(BRIDGE)) {
  failures.push(`${BRIDGE} is missing — the balance-sheet path must stay in its own module`);
}

if (failures.length > 0) {
  console.error("Statement isolation violated:\n");
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(
    "\nThe P&L, cash-flow and transactions tabs must not depend on balance-sheet code.\n" +
      "If a balance-sheet feature needs something from a frozen module, import it the\n" +
      "other way round (balances -> financials), which is allowed and already how\n" +
      "transactionPostings reuses normalizeSign.\n",
  );
  process.exit(1);
}

console.log(`Statement isolation OK — ${FROZEN.length} frozen modules, none reaching into lib/finance/balances.`);
