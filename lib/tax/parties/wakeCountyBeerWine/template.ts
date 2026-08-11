/**
 * Wake County — Beer & Wine License Renewal — party template.
 *
 * Assembles the TaxPartyTemplate and registers it so
 * getParty("wake_county_beer_wine") resolves anywhere in the app. Annual only.
 *
 * PERIOD / DUE DATE — the one thing that is not obvious here. Wake County
 * licenses run May 1 – April 30 and renewal is due by April 30, i.e. the
 * deadline sits BEFORE the license year it buys, not after it. `tasks.ts` only
 * opens a task once a period has ended (`periodsNeedingTasks` excludes the
 * in-progress period), so a period whose due date equals its own end would
 * produce a task one day after the deadline it exists to prevent missing.
 * Instead the period is the license year that just closed (May 1 – April 30)
 * and the due rule is the FIXED calendar deadline `{ fixedMonth: 4, day: 30 }`
 * — the first April 30 strictly after the period ends. The task opens on May 1
 * when that license year closes and carries the NEXT April 30 deadline (a year
 * ending 2026-04-30 is due 2027-04-30), so `lead_days: 7` alerts on 2027-04-23.
 *
 * Which licenses the brewery holds is per-schedule config
 * (`config.license_types`), not a statutory fact — the fee schedule itself is
 * statutory and lives in ./rates.ts. Every worksheet field is computed from
 * those two, so mergeWorksheet fully replaces the field set on recompute.
 *
 * Everything the county's online renewal asks for is already on file and is
 * rendered by TaxWorksheetShell's IdentityHeader: contact name, email and
 * phone from the shared Tax Profile, the Wake County gross receipts account
 * number, its 4-digit gross receipts PIN (a `sensitive` registration, shared
 * with Prepared Food & Beverage) and the FEIN as required registrations.
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
import { resolveDueDate, type DueRule } from "@/lib/tax/dueDate";
import { registerParty } from "@/lib/tax/registry";
import type { RequiredRegistration } from "@/lib/tax/registrations";
import { computeBeerWineWorksheet } from "./calc";
import { resolveWakeBeerWineFieldOwnership } from "./fieldOwnership";
import { BEER_WINE_LICENSE_TYPES, WAKE_BW_REFERENCE } from "./rates";

/** First month of the license year (May). */
const LICENSE_YEAR_START_MONTH = 5;

function defaultDueRule(freq: Frequency): DueRule {
  // A fixed calendar deadline, not an offset: the county's renewal is due
  // April 30, and `resolveDueDate` picks the first April 30 strictly after the
  // period ends — so the license year closing 2026-04-30 carries 2027-04-30.
  if (freq === "annual") return { fixedMonth: 4, day: 30 };
  throw new Error(`wake_county_beer_wine does not support frequency: ${freq}`);
}

/** The May 1 – April 30 license year containing `ref`. */
function licenseYearPeriod(ref: Date): { start: string; end: string } {
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth() + 1;
  const startYear = month >= LICENSE_YEAR_START_MONTH ? year : year - 1;
  return { start: `${startYear}-05-01`, end: `${startYear + 1}-04-30` };
}

function computePeriod(freq: Frequency, ref: Date): TaxPeriod {
  if (freq !== "annual") throw new Error(`wake_county_beer_wine does not support frequency: ${freq}`);
  const { start, end } = licenseYearPeriod(ref);
  return { start, end, due: resolveDueDate(end, defaultDueRule(freq)) };
}

export { resolveWakeBeerWineFieldOwnership } from "./fieldOwnership";

const fieldOwnership: Record<string, FieldOwnership> = new Proxy({} as Record<string, FieldOwnership>, {
  get: (_target, prop) => (typeof prop === "string" ? resolveWakeBeerWineFieldOwnership(prop) : undefined),
});

// Every field is computed — nothing manual to preserve — so a recompute fully
// replaces the field set. `rateMap` is accepted for interface parity but
// unused: the fees are flat statutory amounts, not tax_rates rows.
function mergeWorksheet(
  _current: WorksheetData,
  recomputed: WorksheetData,
  _rateMap: Record<string, number>,
): WorksheetData {
  return { fields: { ...recomputed.fields }, warnings: recomputed.warnings, meta: recomputed.meta };
}

// Nothing party-specific to configure: the county account number and PIN are
// shared `tax_registrations` rows (see requiredRegistrations below), and the
// fees are statutory.
const settingsSchema: FieldSpec[] = [];

const scheduleConfigSchema: FieldSpec[] = [
  {
    key: "license_types",
    label: "License types held",
    type: "multiselect",
    required: true,
    options: BEER_WINE_LICENSE_TYPES.map((t) => ({
      value: t.value,
      label: `${t.label} — $${(t.feeCents / 100).toFixed(2)}`,
    })),
    help: "Which Wake County beer & wine licenses this brewery renews. The renewal total is the sum of the selected licenses' annual fees.",
  },
];

function buildReferenceView(_rateMap: Record<string, number>): ReferenceSpec {
  // Flat statutory fees, not tax_rates rows — the reference is fully static.
  return WAKE_BW_REFERENCE;
}

const requiredRegistrations: RequiredRegistration[] = [
  {
    authorityKey: "wake_county",
    registrationKey: "wake_county_account_id",
    label: "Wake County Gross Receipts Account Number",
    identityOrder: 1,
  },
  // The gross receipts PIN is the credential for the SAME county account, so
  // it is one shared registration row, not a per-module setting — Prepared
  // Food & Beverage declares the identical kind and both resolve to it.
  {
    authorityKey: "wake_county",
    registrationKey: "wake_county_pin",
    label: "Wake County Gross Receipts PIN",
    identityOrder: 2,
    sensitive: true,
  },
  // The county issues the beer & wine license only against an NC ABC permit;
  // the taproom's on-premise permit is the same row Prepared Food & Beverage
  // resolves (same authority + registrationKey), not a second copy.
  {
    authorityKey: "nc_abc",
    registrationKey: "abc_permit_number_onpremise",
    label: "NC ABC On-Premise Permit Number",
    identityOrder: 3,
  },
];

export const wakeCountyBeerWineTemplate: TaxPartyTemplate = {
  key: "wake_county_beer_wine",
  label: "Wake County — Beer & Wine License Renewal",
  supportedFrequencies: ["annual"],
  computePeriod,
  defaultDueRule,
  computeWorksheet: (ctx: ComputeContext) => computeBeerWineWorksheet(ctx),
  fieldOwnership,
  mergeWorksheet,
  settingsSchema,
  scheduleConfigSchema,
  requiredRegistrations,
  buildReferenceView,
  recomputeLabel: "Recompute from Schedule",
  worksheetComponent: "wake_county_beer_wine",
};

registerParty(wakeCountyBeerWineTemplate);
