/**
 * NC DOR Beer Excise Tax (Form B-C-710) — party template.
 *
 * Assembles the `TaxPartyTemplate` for NC DOR's beer wholesalers/resident-
 * brewery excise return from the period math (`@/lib/tax/period`), the calc
 * engine (`./calc`), and the shared figure derivation (`./derive`), then
 * registers it with the in-memory party registry so
 * `getParty("nc_dor_beer_excise")` resolves it anywhere in the app.
 */
import type {
  ComputeContext,
  FieldOwnership,
  FieldSpec,
  Frequency,
  TaxPartyTemplate,
  TaxPeriod,
  WorksheetData,
} from "@/lib/tax/types";
import { monthPeriod } from "@/lib/tax/period";
import { resolveDueDate, type DueRule } from "@/lib/tax/dueDate";
import { registerParty } from "@/lib/tax/registry";
import { US_STATES } from "@/lib/tax/usStates";
import { computeBeerExciseWorksheet } from "./calc";
import { deriveBeerExciseFigures } from "./derive";
import { resolveBeerFieldOwnership } from "./fieldOwnership";
import { BEER_EXCISE_REFERENCE } from "./rates";

// ── Period / due-date rule ──────────────────────────────────────────────────
//
// Monthly only: period = calendar month; due = the 15th of the FOLLOWING month.

function defaultDueRule(freq: Frequency): DueRule {
  if (freq === "monthly") return { monthOffset: 1, day: 15 };
  throw new Error(`nc_dor_beer_excise does not support frequency: ${freq}`);
}

function computePeriod(freq: Frequency, ref: Date): TaxPeriod {
  if (freq !== "monthly") throw new Error(`nc_dor_beer_excise does not support frequency: ${freq}`);
  const { start, end } = monthPeriod(ref);
  return { start, end, due: resolveDueDate(end, defaultDueRule(freq)) };
}

// ── fieldOwnership ──────────────────────────────────────────────────────────
//
// Re-exported for any server-side caller that wants the resolver directly
// rather than through the Proxy.
export { resolveBeerFieldOwnership } from "./fieldOwnership";

const fieldOwnership: Record<string, FieldOwnership> = new Proxy(
  {} as Record<string, FieldOwnership>,
  {
    get: (_target, prop) => (typeof prop === "string" ? resolveBeerFieldOwnership(prop) : undefined),
  },
);

// ── mergeWorksheet ──────────────────────────────────────────────────────────
//
// For every key across both worksheets: a "computed" field always takes the
// freshly recomputed value; a "manual" field keeps whatever the user already
// entered (`current`), falling back to `recomputed` only if there's nothing
// there yet. The full figure set is then re-derived from that merged field
// set via the SAME `deriveBeerExciseFigures` the initial compute and the
// client use — so a manual `cents_penalty` edit (preserved from `current`)
// flows into L11 exactly as the client already displays it.

function mergeWorksheet(current: WorksheetData, recomputed: WorksheetData): WorksheetData {
  const keys = new Set([...Object.keys(current.fields), ...Object.keys(recomputed.fields)]);
  const merged: Record<string, number | string | null> = {};

  for (const key of keys) {
    merged[key] =
      fieldOwnership[key] === "computed"
        ? recomputed.fields[key]
        : (current.fields[key] ?? recomputed.fields[key]);
  }

  const fields = deriveBeerExciseFigures(merged);

  return { fields, warnings: recomputed.warnings, meta: recomputed.meta };
}

// ── settingsSchema / scheduleConfigSchema ───────────────────────────────────

const settingsSchema: FieldSpec[] = [
  { key: "abc_permit_number", label: "ABC Permit Number", type: "text" },
  { key: "state_of_domicile", label: "State of Domicile", type: "select", options: US_STATES },
  { key: "fax_number", label: "Fax", type: "tel" },
  { key: "signer_title", label: "Signer Title", type: "text" },
];

const scheduleConfigSchema: FieldSpec[] = [];

// ── Assembled template ──────────────────────────────────────────────────────

export const ncDorBeerExciseTemplate: TaxPartyTemplate = {
  key: "nc_dor_beer_excise",
  label: "NC DOR — Beer Excise Tax (B-C-710)",
  supportedFrequencies: ["monthly"],
  computePeriod,
  defaultDueRule,
  computeWorksheet: (ctx: ComputeContext) => computeBeerExciseWorksheet(ctx),
  fieldOwnership,
  mergeWorksheet,
  settingsSchema,
  scheduleConfigSchema,
  referenceView: BEER_EXCISE_REFERENCE,
  recomputeLabel: "Recompute from shipments",
  worksheetComponent: "nc_dor_beer_excise",
};

registerParty(ncDorBeerExciseTemplate);
