/**
 * NC DOR Sales & Use Tax — party template.
 *
 * Assembles the `TaxPartyTemplate` for NC DOR Form E-500 (Sales & Use, first
 * party) from the period math (`@/lib/tax/period`), the calc engine
 * (`./calc`), and the statutory rate tables (`./rates`), then registers it
 * with the in-memory party registry so `getParty("nc_dor_sales_use")`
 * resolves it anywhere in the app.
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
import { monthPeriod, quarterPeriod } from "@/lib/tax/period";
import { resolveDueDate, type DueRule } from "@/lib/tax/dueDate";
import { registerParty } from "@/lib/tax/registry";
import { computeNcDorWorksheet } from "./calc";
import { deriveNcDorFigures } from "./derive";
import { resolveFieldOwnership } from "./fieldOwnership";
import { NC_COUNTIES, NC_COUNTY_TIERS, NC_STATE_RATE } from "./rates";

// ── Period / due-date rules ────────────────────────────────────────────────
//
// Monthly:   period = calendar month; due = the 20th of the FOLLOWING month.
// Quarterly: period = calendar quarter; due = the LAST DAY of the month
//            following the quarter's end (NC DOR's standard quarterly rule).

function defaultDueRule(freq: Frequency): DueRule {
  if (freq === "monthly") return { monthOffset: 1, day: 20 };
  if (freq === "quarterly") return { monthOffset: 1, day: "last" };
  throw new Error(`nc_dor_sales_use does not support frequency: ${freq}`);
}

function computePeriod(freq: Frequency, ref: Date): TaxPeriod {
  const { start, end } =
    freq === "monthly"
      ? monthPeriod(ref)
      : freq === "quarterly"
        ? quarterPeriod(ref)
        : (() => {
            throw new Error(`nc_dor_sales_use does not support frequency: ${freq}`);
          })();
  return { start, end, due: resolveDueDate(end, defaultDueRule(freq)) };
}

// ── fieldOwnership ──────────────────────────────────────────────────────────
//
// `TaxPartyTemplate.fieldOwnership` is typed `Record<string, FieldOwnership>`.
// Most worksheet keys are static, but two families are dynamic and unbounded
// at the type level:
//   - `lineN_{purchases|receipts|tax}` for N in the active rate lines (4-12)
//   - `county_{CODE}_{2pct|225pct|transit}` for whichever counties are
//     selected on the schedule (a subset of the 100 NC counties)
// Rather than pre-populating an object with every county x suffix
// combination, `resolveFieldOwnership` (imported from the pure
// `./fieldOwnership` module — the single source of truth shared with the
// client worksheet) PARSES the key (prefix/suffix) and a `Proxy` exposes
// that resolver behind the same `Record<string, FieldOwnership>` shape
// `mergeWorksheet`'s callers (and the type) expect.

// Re-exported for the existing test import path (`./template`'s
// `resolveFieldOwnership`) and any other server-side caller that wants the
// resolver directly rather than through the Proxy.
export { resolveFieldOwnership } from "./fieldOwnership";

const fieldOwnership: Record<string, FieldOwnership> = new Proxy(
  {} as Record<string, FieldOwnership>,
  {
    get: (_target, prop) => (typeof prop === "string" ? resolveFieldOwnership(prop) : undefined),
  },
);

// ── mergeWorksheet ──────────────────────────────────────────────────────────
//
// For every key across both worksheets: a "computed" field always takes the
// freshly recomputed value; a "manual" field keeps whatever the user already
// entered (`current`), falling back to `recomputed` only if there's nothing
// there yet. The full figure set (per-line tax, page-2 county rows, and the
// dependent totals 13/15/21) is then re-derived from that merged field set via
// the SAME `deriveNcDorFigures` the initial compute and the client use — so a
// manual `lineN_purchases` edit (preserved from `current`) flows into the line
// tax, county rows, and Total Due exactly as the client already displays it.

function mergeWorksheet(current: WorksheetData, recomputed: WorksheetData): WorksheetData {
  const keys = new Set([...Object.keys(current.fields), ...Object.keys(recomputed.fields)]);
  const merged: Record<string, number | string | null> = {};

  for (const key of keys) {
    merged[key] =
      fieldOwnership[key] === "computed"
        ? recomputed.fields[key]
        : (current.fields[key] ?? recomputed.fields[key]);
  }

  const fields = deriveNcDorFigures(merged);

  return { fields, warnings: recomputed.warnings, meta: recomputed.meta };
}

// ── settingsSchema / scheduleConfigSchema ───────────────────────────────────

const settingsSchema: FieldSpec[] = [
  {
    key: "general_sales_tax_id",
    label: "Square General Sales Tax",
    type: "select",
    help: "The Square catalog tax representing NC general sales & use tax. Options are fetched from Square's catalog taxes when this field is rendered.",
  },
];

const scheduleConfigSchema: FieldSpec[] = [
  {
    key: "counties",
    label: "Counties",
    type: "select",
    options: NC_COUNTIES.map((c) => ({ value: c.code, label: c.name })),
    help: "Counties where taxable sales occur. Each selected county carries a weight (%) of the period's taxable receipts, stored in schedule.config.counties as { code, weight } pairs whose weights should sum to 100 — the schedule editor UI manages per-county weights beyond this field's option list.",
  },
];

// ── referenceView ────────────────────────────────────────────────────────────

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

const referenceView: ReferenceSpec = {
  tables: [
    {
      title: "State rate",
      columns: ["Rate", "Applies to"],
      rows: [[formatPct(NC_STATE_RATE), "All taxable receipts (Form E-500, Line 4)"]],
    },
    {
      title: "County local/transit tax tiers",
      columns: ["County", "Local rate", "Transit rate", "Combined rate"],
      rows: NC_COUNTIES.map((c) => {
        const tier = NC_COUNTY_TIERS[c.code];
        return [c.name, formatPct(tier.local), formatPct(tier.transit), formatPct(tier.local + tier.transit)];
      }),
    },
  ],
  notes: [
    "Monthly filers: period = calendar month; due the 20th of the following month.",
    "Quarterly filers: period = calendar quarter; due the last day of the month following the quarter's end.",
    "State rate and county tiers above are statutory (NC DOR) and read-only — not editable filing data.",
  ],
};

// ── Assembled template ──────────────────────────────────────────────────────

export const ncDorSalesUseTemplate: TaxPartyTemplate = {
  key: "nc_dor_sales_use",
  label: "NC DOR — Sales & Use Tax",
  supportedFrequencies: ["monthly", "quarterly"],
  computePeriod,
  defaultDueRule,
  computeWorksheet: (ctx: ComputeContext) => computeNcDorWorksheet(ctx),
  fieldOwnership,
  mergeWorksheet,
  settingsSchema,
  scheduleConfigSchema,
  referenceView,
  recomputeLabel: "Recompute from Square",
  worksheetComponent: "nc_dor_sales_use",
};

registerParty(ncDorSalesUseTemplate);
