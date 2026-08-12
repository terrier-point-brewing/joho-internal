/**
 * TTB Pilot Brewer Excise Tax Return and Report of Operations
 * (TTB F 5130.Pilot-B) — party template.
 *
 * Assembles the `TaxPartyTemplate` from the period math (`@/lib/tax/period`),
 * the calc engine (`./calc`) and the shared figure derivation (`./derive`),
 * then registers it with the in-memory party registry so
 * `getParty("ttb_beer_excise")` resolves it anywhere in the app.
 *
 * This is the pilot form from TTB Industry Circular 2025-1: one filing that
 * replaces BOTH the excise tax return (TTB F 5000.24) and the Brewer's Report
 * of Operations (TTB F 5130.9). That is why the worksheet carries an
 * operations section (Lines 28-44) that no other party here has.
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
import { quarterPeriod } from "@/lib/tax/period";
import { resolveDueDate, type DueRule } from "@/lib/tax/dueDate";
import { registerParty } from "@/lib/tax/registry";
import { TAX_RATE_KEYS } from "@/lib/tax/rates";
import type { RequiredRegistration } from "@/lib/tax/registrations";
import { computeTtbWorksheet } from "./calc";
import { deriveTtbFigures } from "./derive";
import { resolveTtbFieldOwnership } from "./fieldOwnership";
import { TTB_REFERENCE } from "./rates";

// ── Period / due-date rule ──────────────────────────────────────────────────
//
// Quarterly only: period = calendar quarter; return and full payment are due
// 14 days after the quarter ends. `{ monthOffset: 1, day: 14 }` expresses that
// exactly, because a calendar quarter always ends on the last day of a month —
// Q3 ends 09-30, one month on is October, day 14 → 10-14.

function defaultDueRule(freq: Frequency): DueRule {
  if (freq === "quarterly") return { monthOffset: 1, day: 14 };
  throw new Error(`ttb_beer_excise does not support frequency: ${freq}`);
}

function computePeriod(freq: Frequency, ref: Date): TaxPeriod {
  if (freq !== "quarterly") throw new Error(`ttb_beer_excise does not support frequency: ${freq}`);
  const { start, end } = quarterPeriod(ref);
  return { start, end, due: resolveDueDate(end, defaultDueRule(freq)) };
}

// ── fieldOwnership ──────────────────────────────────────────────────────────
//
// Re-exported for any server-side caller that wants the resolver directly
// rather than through the Proxy.
export { resolveTtbFieldOwnership } from "./fieldOwnership";

const fieldOwnership: Record<string, FieldOwnership> = new Proxy(
  {} as Record<string, FieldOwnership>,
  {
    get: (_target, prop) => (typeof prop === "string" ? resolveTtbFieldOwnership(prop) : undefined),
  },
);

// ── mergeWorksheet ──────────────────────────────────────────────────────────
//
// For every key across both worksheets: a "computed" field always takes the
// freshly recomputed value; a "manual" field keeps whatever the user already
// entered (`current`), falling back to `recomputed` only if there's nothing
// there yet. The full figure set is then re-derived from that merged field set
// via the SAME `deriveTtbFigures` the initial compute and the client use — so a
// manual export entry (preserved from `current`) flows through Lines 37, 43 and
// 29 exactly as the client already displays it.
//
// `rateMap` is accepted for interface parity with
// `TaxPartyTemplate.mergeWorksheet` but unused here — the federal rate is
// fetched directly in `./calc.ts` and carried on the worksheet as
// `ttb_reduced_rate_micros`.
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

  return { fields: deriveTtbFigures(merged), warnings: recomputed.warnings, meta: recomputed.meta };
}

// ── buildReferenceView ──────────────────────────────────────────────────────
//
// Reads the reduced-rate line from the canonical rateMap (key
// `federal_beer_excise`) when present; falls back to the static
// `TTB_REFERENCE` text (statutory $3.50/bbl) if that row is absent. Lines 9 and
// 10 are statutory and never configurable, so only the first row is swapped.

function buildReferenceView(rateMap: Record<string, number>): ReferenceSpec {
  const rate = rateMap[TAX_RATE_KEYS.FEDERAL_BEER_EXCISE];
  if (rate == null) return TTB_REFERENCE;

  const [reducedRow, ...restRows] = TTB_REFERENCE.tables[0].rows;
  return {
    ...TTB_REFERENCE,
    tables: [
      {
        ...TTB_REFERENCE.tables[0],
        rows: [[`$${rate.toFixed(2)} per barrel`, reducedRow[1], reducedRow[2]], ...restRows],
      },
      ...TTB_REFERENCE.tables.slice(1),
    ],
  };
}

// ── settingsSchema / scheduleConfigSchema ───────────────────────────────────

// Filer identity (brewery name, premises address, contact name/phone/email,
// EIN, brewer's notice number) is sourced entirely from the shared Tax Profile
// (tax_entity_profile / tax_registrations) — see `TaxWorksheetShell`'s
// IdentityHeader. This party needs no settings of its own.
const settingsSchema: FieldSpec[] = [];

// Nothing here is per-schedule either. Controlled-group membership (Line 45)
// looked like schedule config, but it is answered on the return itself and can
// change between quarters, so it lives on the worksheet as a manual field.
const scheduleConfigSchema: FieldSpec[] = [];

const requiredRegistrations: RequiredRegistration[] = [
  // The federal_ttb registration row has existed since the tax settings
  // restructure with a NULL `registration_kind`, precisely because no template
  // had claimed it yet (see
  // supabase/migrations/20261003090005_tax_registration_kind.sql's header).
  // This template is that claim; the accompanying migration gives the row its
  // kind.
  {
    authorityKey: "federal_ttb",
    registrationKey: "ttb_brewers_notice",
    label: "TTB Brewer's Notice Number",
  },
];

// ── Assembled template ──────────────────────────────────────────────────────

export const ttbBeerExciseTemplate: TaxPartyTemplate = {
  key: "ttb_beer_excise",
  label: "TTB — Pilot Brewer Excise Tax Return (5130.Pilot-B)",
  supportedFrequencies: ["quarterly"],
  computePeriod,
  defaultDueRule,
  computeWorksheet: (ctx: ComputeContext) => computeTtbWorksheet(ctx),
  fieldOwnership,
  mergeWorksheet,
  settingsSchema,
  scheduleConfigSchema,
  requiredRegistrations,
  buildReferenceView,
  recomputeLabel: "Recompute from shipments",
  worksheetComponent: "ttb_beer_excise",
};

registerParty(ttbBeerExciseTemplate);
