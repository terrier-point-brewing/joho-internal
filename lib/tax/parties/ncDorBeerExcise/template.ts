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
  ReferenceSpec,
  TaxPartyTemplate,
  TaxPeriod,
  WorksheetData,
} from "@/lib/tax/types";
import { monthPeriod } from "@/lib/tax/period";
import { resolveDueDate, type DueRule } from "@/lib/tax/dueDate";
import { registerParty } from "@/lib/tax/registry";
import { TAX_RATE_KEYS } from "@/lib/tax/rates";
import type { RequiredRegistration } from "@/lib/tax/registrations";
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

// `rateMap` is accepted for interface parity with `TaxPartyTemplate.mergeWorksheet`
// (the sales-use party needs it) but unused here — the beer excise rate is
// fetched directly in `./calc.ts`/`./derive.ts`, not threaded through merge.
function mergeWorksheet(
  current: WorksheetData,
  recomputed: WorksheetData,
  _rateMap: Record<string, number>,
): WorksheetData {
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

// ── buildReferenceView ──────────────────────────────────────────────────────
//
// Reads the excise rate line from the canonical rateMap (key
// `nc_dor_beer_excise`) when present; falls back to the static
// `BEER_EXCISE_REFERENCE` text (statutory $0.6171/gal) if that row is absent.

function buildReferenceView(rateMap: Record<string, number>): ReferenceSpec {
  const rate = rateMap[TAX_RATE_KEYS.NC_DOR_BEER_EXCISE];
  if (rate == null) return BEER_EXCISE_REFERENCE;

  return {
    ...BEER_EXCISE_REFERENCE,
    tables: [
      {
        ...BEER_EXCISE_REFERENCE.tables[0],
        rows: [
          [`${(rate * 100).toFixed(2)}¢ per gallon`, "Taxable malt beverage gallons (Form B-C-710, Line 6)"],
          ...BEER_EXCISE_REFERENCE.tables[0].rows.slice(1),
        ],
      },
      ...BEER_EXCISE_REFERENCE.tables.slice(1),
    ],
  };
}

// ── settingsSchema / scheduleConfigSchema ───────────────────────────────────

// Filer identity (legal name, trade name, address, contact, FEIN, NCDOR
// account #, ABC permit #, state of domicile, phone/fax) is now sourced
// entirely from the shared Tax Profile (tax_entity_profile /
// tax_registrations) — see app/finance/tax/[taskId]/TaxWorksheetShell.tsx's
// IdentityHeader. This party needs no settings of its own.
const settingsSchema: FieldSpec[] = [];

const scheduleConfigSchema: FieldSpec[] = [];

const requiredRegistrations: RequiredRegistration[] = [
  { authorityKey: "nc_dor", registrationKey: "nc_dor_account_id", label: "NC DOR Account / License Number" },
  // Brewery-side excise filing needs the wholesaler permit, not the taproom's
  // on-premise sales permit (see wakeCountyFoodBeverage/template.ts) — same
  // `nc_abc` authority, distinct registrationKey so both can be on file at once.
  { authorityKey: "nc_abc", registrationKey: "abc_permit_number", label: "NC ABC Wholesaler Permit Number" },
];

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
  requiredRegistrations,
  buildReferenceView,
  recomputeLabel: "Recompute from shipments",
  worksheetComponent: "nc_dor_beer_excise",
};

registerParty(ncDorBeerExciseTemplate);
