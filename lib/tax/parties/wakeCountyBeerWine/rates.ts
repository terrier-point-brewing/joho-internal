/**
 * Wake County — Beer & Wine License renewal — statutory fee schedule + reference.
 *
 * The four fees are flat annual dollar amounts per license type, NOT rates on a
 * base, so they deliberately do NOT live in `tax_rates` (whose `basis` is
 * per_bbl / per_gallon / percent — none of which describes a $25 license). They
 * are statutory constants here, mirroring how the county publishes them.
 *
 * Zero server imports so this stays importable by both the pure
 * ./fieldOwnership.ts module (client-safe) and the server ./calc.ts / ./template.ts.
 */
import type { ReferenceSpec } from "@/lib/tax/types";

/** One selectable license type and its flat annual fee. */
export interface BeerWineLicenseType {
  /** Stored in `tax_schedules.config.license_types` and used as a worksheet field suffix. */
  value: string;
  label: string;
  feeCents: number;
}

/**
 * The county's full fee schedule. Order is the order the county lists them,
 * and the order both the schedule editor and the worksheet render.
 */
export const BEER_WINE_LICENSE_TYPES: BeerWineLicenseType[] = [
  { value: "on_premise_malt", label: "On-premises malt beverage", feeCents: 2500 },
  { value: "off_premise_malt", label: "Off-premises malt beverage", feeCents: 500 },
  { value: "on_premise_wine", label: "On-premises wine", feeCents: 2500 },
  { value: "off_premise_wine", label: "Off-premises wine", feeCents: 2500 },
];

/** Worksheet field key holding the fee for one license type, e.g. `wake_bw_fee_on_premise_malt_cents`. */
export function licenseFeeFieldKey(licenseType: string): string {
  return `wake_bw_fee_${licenseType}_cents`;
}

export function findLicenseType(value: string): BeerWineLicenseType | undefined {
  return BEER_WINE_LICENSE_TYPES.find((t) => t.value === value);
}

export const WAKE_BW_REFERENCE: ReferenceSpec = {
  tables: [
    {
      title: "Annual License Fees",
      columns: ["License type", "Annual fee"],
      rows: BEER_WINE_LICENSE_TYPES.map((t) => [t.label, `$${(t.feeCents / 100).toFixed(2)}`]),
    },
  ],
  notes: [
    "License year runs May 1 – April 30; renewal is due by April 30 and a monthly penalty accrues if it is not renewed on time.",
    "Renewal notices are mailed in March; submissions are manually reviewed within 5 business days.",
    "Which license types this brewery holds is per-schedule config, not a statutory fact — set it on the schedule (Finance → Tax → Schedules).",
    "Renewing online needs the Wake County gross receipts account number and 4-digit PIN, the FEIN, and a contact name, email and phone — all shown on the worksheet's Filing Identity header.",
    "Renewal requires no outstanding balance (beyond the renewal fee) and all property taxes paid under the same ownership.",
    "Fees are flat statutory amounts published by Wake County Tax Administration; they are not in the tax_rates registry because they are not rates.",
  ],
};
