/**
 * Wake County — Prepared Food & Beverage Tax — party template.
 *
 * Assembles the TaxPartyTemplate and registers it so
 * getParty("wake_county_food_beverage") resolves anywhere in the app. Monthly
 * only; due the 20th of the following month. Every worksheet field is computed
 * (no manual inputs), so mergeWorksheet fully replaces the field set with the
 * recompute. Filer identity (contact person, address) comes from the shared
 * Tax Profile (tax_legal_representative / tax_entity_profile) via
 * TaxWorksheetShell's IdentityHeader; the Wake County account # is a required
 * registration and the 4-digit PIN is a sensitive settings field.
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
import type { RequiredRegistration } from "@/lib/tax/registrations";
import { computeWakeWorksheet } from "./calc";
import { resolveWakeFieldOwnership } from "./fieldOwnership";
import { WAKE_FB_RATE_KEY, WAKE_FB_REFERENCE } from "./rates";

function defaultDueRule(freq: Frequency): DueRule {
  if (freq === "monthly") return { monthOffset: 1, day: 20 };
  throw new Error(`wake_county_food_beverage does not support frequency: ${freq}`);
}

function computePeriod(freq: Frequency, ref: Date): TaxPeriod {
  if (freq !== "monthly") throw new Error(`wake_county_food_beverage does not support frequency: ${freq}`);
  const { start, end } = monthPeriod(ref);
  return { start, end, due: resolveDueDate(end, defaultDueRule(freq)) };
}

export { resolveWakeFieldOwnership } from "./fieldOwnership";

const fieldOwnership: Record<string, FieldOwnership> = new Proxy({} as Record<string, FieldOwnership>, {
  get: (_target, prop) => (typeof prop === "string" ? resolveWakeFieldOwnership(prop) : undefined),
});

// Every field is computed — nothing manual to preserve — so a recompute fully
// replaces the field set. `rateMap` is accepted for interface parity but unused
// (the rate is read directly in ./calc.ts).
function mergeWorksheet(
  _current: WorksheetData,
  recomputed: WorksheetData,
  _rateMap: Record<string, number>,
): WorksheetData {
  return { fields: { ...recomputed.fields }, warnings: recomputed.warnings, meta: recomputed.meta };
}

const settingsSchema: FieldSpec[] = [
  {
    key: "food_beverage_tax_id",
    label: "Square Prepared Food & Beverage Tax",
    type: "select",
    required: true,
    help: "The Square catalog tax representing the Wake County Prepared Food & Beverage Tax. Drives Applicable Gross Receipts and Tax Owed. Options are fetched from Square's catalog taxes.",
  },
  {
    key: "general_sales_tax_id",
    label: "Square General Sales Tax (for Gross Receipts)",
    type: "select",
    help: "Optional — the Square general sales tax, used only to show the Gross Receipts comparison row. Leave blank to omit that row.",
  },
  {
    key: "filing_pin",
    label: "Wake County Filing PIN",
    type: "text",
    sensitive: true,
    help: "The 4-digit PIN required to submit the Wake County return. Stored securely and never displayed after saving.",
  },
];

const scheduleConfigSchema: FieldSpec[] = [];

function buildReferenceView(rateMap: Record<string, number>): ReferenceSpec {
  const rate = rateMap[WAKE_FB_RATE_KEY];
  if (rate == null) return WAKE_FB_REFERENCE;
  return {
    ...WAKE_FB_REFERENCE,
    tables: [
      {
        ...WAKE_FB_REFERENCE.tables[0],
        rows: [[`${(rate * 100).toFixed(2)}%`, "Applicable prepared food & beverage gross receipts"]],
      },
    ],
  };
}

const requiredRegistrations: RequiredRegistration[] = [
  {
    authorityKey: "wake_county",
    registrationKey: "wake_county_account_id",
    label: "Wake County Gross Receipts Account Number",
  },
];

export const wakeCountyFoodBeverageTemplate: TaxPartyTemplate = {
  key: "wake_county_food_beverage",
  label: "Wake County — Prepared Food & Beverage Tax",
  supportedFrequencies: ["monthly"],
  computePeriod,
  defaultDueRule,
  computeWorksheet: (ctx: ComputeContext) => computeWakeWorksheet(ctx),
  fieldOwnership,
  mergeWorksheet,
  settingsSchema,
  scheduleConfigSchema,
  requiredRegistrations,
  buildReferenceView,
  recomputeLabel: "Recompute from Square",
  worksheetComponent: "wake_county_food_beverage",
};

registerParty(wakeCountyFoodBeverageTemplate);
