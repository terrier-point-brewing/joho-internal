/**
 * NC DOR Sales & Use Tax — structural rate-schedule constants.
 *
 * Rate VALUES live in the canonical `tax_rates` table (see
 * `@/lib/tax/rates`) — this module only keeps the STRUCTURE: which rate
 * lines exist (4–12), the 100 NC counties and their DOR schedule codes, and
 * the pure mapping from a county's RESOLVED local/transit rate to its
 * Form E-500 line number. Callers read rate VALUES through a `rateMap`
 * (built via `buildRateMap(await listTaxRates(sb))`) keyed by
 * `ncSalesLineKey`/`ncLocalKey`/`ncTransitKey` — never from a constant here.
 */

/**
 * Rate lines that carry a purchases/receipts/tax triple on the worksheet.
 * Lives here (not calc.ts) so this stays a zero-server-import pure module —
 * both `calc.ts` and the pure `fieldOwnership.ts` (shared by the server
 * template and the client worksheet) derive from this single source instead
 * of duplicating the line numbers.
 */
export const RATE_LINES = [4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/** The rate-line numbers, as the string keys used across worksheet fields. */
export type RateLineKey = "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12";

/**
 * Represents a county's RESOLVED local/transit tax rates (read from the
 * rate map — never a hardcoded constant).
 */
export interface CountyTier {
  local: number;
  transit: number;
}

/** NC DOR county schedule codes and names */
const COUNTY_DATA = [
  { ncCode: 1, name: 'Alamance' },
  { ncCode: 2, name: 'Alexander' },
  { ncCode: 3, name: 'Alleghany' },
  { ncCode: 4, name: 'Anson' },
  { ncCode: 5, name: 'Ashe' },
  { ncCode: 6, name: 'Avery' },
  { ncCode: 7, name: 'Beaufort' },
  { ncCode: 8, name: 'Bertie' },
  { ncCode: 9, name: 'Bladen' },
  { ncCode: 10, name: 'Brunswick' },
  { ncCode: 11, name: 'Buncombe' },
  { ncCode: 12, name: 'Burke' },
  { ncCode: 13, name: 'Cabarrus' },
  { ncCode: 14, name: 'Caldwell' },
  { ncCode: 15, name: 'Camden' },
  { ncCode: 16, name: 'Carteret' },
  { ncCode: 17, name: 'Caswell' },
  { ncCode: 18, name: 'Catawba' },
  { ncCode: 19, name: 'Chatham' },
  { ncCode: 20, name: 'Cherokee' },
  { ncCode: 21, name: 'Chowan' },
  { ncCode: 22, name: 'Clay' },
  { ncCode: 23, name: 'Cleveland' },
  { ncCode: 24, name: 'Columbus' },
  { ncCode: 25, name: 'Craven' },
  { ncCode: 26, name: 'Cumberland' },
  { ncCode: 27, name: 'Currituck' },
  { ncCode: 28, name: 'Dare' },
  { ncCode: 29, name: 'Davidson' },
  { ncCode: 30, name: 'Davie' },
  { ncCode: 31, name: 'Duplin' },
  { ncCode: 32, name: 'Durham' },
  { ncCode: 33, name: 'Edgecombe' },
  { ncCode: 34, name: 'Forsyth' },
  { ncCode: 35, name: 'Franklin' },
  { ncCode: 36, name: 'Gaston' },
  { ncCode: 37, name: 'Gates' },
  { ncCode: 38, name: 'Graham' },
  { ncCode: 39, name: 'Granville' },
  { ncCode: 40, name: 'Greene' },
  { ncCode: 41, name: 'Guilford' },
  { ncCode: 42, name: 'Halifax' },
  { ncCode: 43, name: 'Harnett' },
  { ncCode: 44, name: 'Haywood' },
  { ncCode: 45, name: 'Henderson' },
  { ncCode: 46, name: 'Hertford' },
  { ncCode: 47, name: 'Hoke' },
  { ncCode: 48, name: 'Hyde' },
  { ncCode: 49, name: 'Iredell' },
  { ncCode: 50, name: 'Jackson' },
  { ncCode: 51, name: 'Johnston' },
  { ncCode: 52, name: 'Jones' },
  { ncCode: 53, name: 'Lee' },
  { ncCode: 54, name: 'Lenoir' },
  { ncCode: 55, name: 'Lincoln' },
  { ncCode: 56, name: 'Macon' },
  { ncCode: 57, name: 'Madison' },
  { ncCode: 58, name: 'Martin' },
  { ncCode: 59, name: 'McDowell' },
  { ncCode: 60, name: 'Mecklenburg' },
  { ncCode: 61, name: 'Mitchell' },
  { ncCode: 62, name: 'Montgomery' },
  { ncCode: 63, name: 'Moore' },
  { ncCode: 64, name: 'Nash' },
  { ncCode: 65, name: 'New Hanover' },
  { ncCode: 66, name: 'Northampton' },
  { ncCode: 67, name: 'Onslow' },
  { ncCode: 68, name: 'Orange' },
  { ncCode: 69, name: 'Pamlico' },
  { ncCode: 70, name: 'Pasquotank' },
  { ncCode: 71, name: 'Pender' },
  { ncCode: 72, name: 'Perquimans' },
  { ncCode: 73, name: 'Person' },
  { ncCode: 74, name: 'Pitt' },
  { ncCode: 75, name: 'Polk' },
  { ncCode: 76, name: 'Randolph' },
  { ncCode: 77, name: 'Richmond' },
  { ncCode: 78, name: 'Robeson' },
  { ncCode: 79, name: 'Rockingham' },
  { ncCode: 80, name: 'Rowan' },
  { ncCode: 81, name: 'Rutherford' },
  { ncCode: 82, name: 'Sampson' },
  { ncCode: 83, name: 'Scotland' },
  { ncCode: 84, name: 'Stanly' },
  { ncCode: 85, name: 'Stokes' },
  { ncCode: 86, name: 'Surry' },
  { ncCode: 87, name: 'Swain' },
  { ncCode: 88, name: 'Transylvania' },
  { ncCode: 89, name: 'Tyrrell' },
  { ncCode: 90, name: 'Union' },
  { ncCode: 91, name: 'Vance' },
  { ncCode: 92, name: 'Wake' },
  { ncCode: 93, name: 'Warren' },
  { ncCode: 94, name: 'Washington' },
  { ncCode: 95, name: 'Watauga' },
  { ncCode: 96, name: 'Wayne' },
  { ncCode: 97, name: 'Wilkes' },
  { ncCode: 98, name: 'Wilson' },
  { ncCode: 99, name: 'Yadkin' },
  { ncCode: 100, name: 'Yancey' },
] as const;

/** Ordered array of NC counties (by NC DOR schedule code) */
export const NC_COUNTIES: { code: string; name: string; ncCode: number }[] = COUNTY_DATA.map(
  ({ ncCode, name }) => ({
    code: name.toUpperCase().replace(/ /g, '_'),
    name,
    ncCode,
  })
);

/**
 * Map a county's RESOLVED local tax rate to its NC DOR form line number.
 * @param localRate The county's local rate (read from the rate map)
 * @returns '9' for 2% local, '10' for 2.25% local
 */
export function countyRateLine(localRate: number): '9' | '10' {
  return localRate === 0.0225 ? '10' : '9';
}

/**
 * Map a county's RESOLVED transit tax rate to its NC DOR form line number.
 * @param transitRate The county's transit rate (read from the rate map)
 * @returns '11' for 0.5% transit, '12' for 0.25% transit, null for no transit
 */
export function transitRateLine(transitRate: number): '11' | '12' | null {
  if (transitRate === 0.005) {
    return '11';
  }
  if (transitRate === 0.0025) {
    return '12';
  }
  return null;
}
