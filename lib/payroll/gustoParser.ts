/**
 * Parser for Gusto's "Payroll Journal Report" CSV export.
 *
 * The export is not a flat table: a metadata preamble (company info,
 * "Payroll period"/"Pay day" rows) precedes a header row ("Last Name",
 * "First Name", ...), followed by one block per employee. Each employee's
 * own row (non-blank Last Name) carries their Regular/Salary `Amount` and
 * pre-summed `Employer Taxes`. It may be followed by blank-Last-Name
 * sub-rows carrying additional pay-type breakdowns — a Bonus (real wage
 * expense, must be added to gross), Paycheck Tips (a balance-sheet
 * pass-through — captured separately, never folded into gross wages), Cash
 * Tips (never moves company money, so it is discarded entirely), and a
 * "Gross" subtotal (sum of the above, would double-count if included). The
 * label for these sub-rows lives in the
 * "Pay Type" column position (index 7) — verified directly against the
 * real export; the first sub-row of a block also carries the literal
 * "Totals" in the "Job" column position (index 6), which is not used here.
 * A "Payroll Totals" row (and everything after it) is the file's own
 * grand-total/by-job-title trailer, not employee data, and is excluded.
 */

// ── Column positions in the per-employee data rows (0-indexed, after the
// header row) — see the export's own header for the full list. ──────────
const COL = {
  lastName: 0,
  firstName: 1,
  department: 2,
  job: 6,
  payType: 7,
  amount: 10,
  employerTaxes: 17,
} as const;

export interface ParsedGustoEmployee {
  lastName: string;
  firstName: string;
  department: string;
  job: string | null;
  payType: string | null;
  grossAmountCents: number;
  employerTaxCents: number;
  /** Sum of this employee's "Paycheck Tips" sub-rows, in cents. 0 when the
   *  employee has no Paycheck Tips sub-row. Never folded into grossAmountCents —
   *  tips are a balance-sheet pass-through, not wage expense. */
  paycheckTipsCents: number;
}

export interface ParsedGustoReport {
  payPeriodStart: string | null; // "YYYY-MM-DD", parsed from "Payroll period" row if present
  payPeriodEnd: string | null;
  payDay: string | null;
  employees: ParsedGustoEmployee[];
  /** departments seen with no entry in payrollDepartmentGlMappings — surfaced, never silently dropped */
  unmappedDepartments: string[];
}

// ── CSV row splitting ──────────────────────────────────────────────────────

function parseCsvRows(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];

  for (const line of normalized.split("\n")) {
    if (line.length === 0) continue; // blank spacer lines in the metadata preamble
    const row: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        row.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    row.push(current);
    rows.push(row);
  }

  return rows;
}

function cell(row: string[], index: number): string {
  return (row[index] ?? "").trim();
}

function parseAmountCents(raw: string): number {
  if (!raw) return 0;
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) return 0;
  return Math.round(value * 100);
}

function toIsoDate(mmddyyyy: string): string | null {
  const match = mmddyyyy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, mm, dd, yyyy] = match;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

export function parseGustoPayrollJournal(csvText: string): ParsedGustoReport {
  if (!csvText || !csvText.trim()) {
    throw new Error("Gusto payroll journal CSV is empty");
  }

  const rows = parseCsvRows(csvText);

  let payPeriodStart: string | null = null;
  let payPeriodEnd: string | null = null;
  let payDay: string | null = null;
  let headerIdx = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const first = cell(row, 0);
    if (first === "Payroll period" && row[1]) {
      const [start, end] = row[1].split(" - ").map((s) => s.trim());
      payPeriodStart = start ? toIsoDate(start) : null;
      payPeriodEnd = end ? toIsoDate(end) : null;
    } else if (first === "Pay day" && row[1]) {
      payDay = toIsoDate(row[1]);
    } else if (first === "Last Name") {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    throw new Error('Could not find the employee header row ("Last Name") in Gusto payroll journal CSV');
  }

  const employees: ParsedGustoEmployee[] = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const lastName = cell(row, COL.lastName);
    if (lastName === "Payroll Totals") break; // grand-total row + trailer that follows

    if (lastName) {
      employees.push({
        lastName,
        firstName: cell(row, COL.firstName),
        department: cell(row, COL.department),
        job: cell(row, COL.job) || null,
        payType: cell(row, COL.payType) || null,
        grossAmountCents: parseAmountCents(cell(row, COL.amount)),
        employerTaxCents: parseAmountCents(cell(row, COL.employerTaxes)),
        paycheckTipsCents: 0,
      });
      continue;
    }

    // Blank-Last-Name sub-row belonging to the most recently started employee.
    const current = employees[employees.length - 1];
    if (!current) continue; // stray sub-row before any employee block — ignore

    const label = cell(row, COL.payType);
    if (label === "Bonus") {
      current.grossAmountCents += parseAmountCents(cell(row, COL.amount));
    } else if (label === "Paycheck Tips") {
      current.paycheckTipsCents += parseAmountCents(cell(row, COL.amount));
    }
    // Cash Tips (never moves company money) and Gross (would double-count) — excluded.
  }

  if (employees.length === 0) {
    throw new Error("No employee rows found in Gusto payroll journal CSV");
  }

  return {
    payPeriodStart,
    payPeriodEnd,
    payDay,
    employees,
    unmappedDepartments: [],
  };
}

export type GlBucketKind = "wages" | "employer_tax" | "tips";

export interface GlBucketTotal {
  chartOfAccountsId: string;
  amountCents: number;
  kind: GlBucketKind;
}

/**
 * Buckets parsed.employees by department via departmentMap, sums employer
 * tax across ALL employees into payrollTaxesAccountId, and sums Paycheck
 * Tips across ALL employees into tipsAccountId — both are company-wide
 * liability buckets, independent of department mapping. Employees whose
 * department isn't in departmentMap contribute to parsed.unmappedDepartments
 * (already populated by parseGustoPayrollJournal) and are excluded from the
 * wage buckets (but still contribute to taxes/tips). The tips bucket is
 * omitted entirely when the summed amount is 0 — never a $0 row.
 */
export function computeGlBucketTotals(
  parsed: ParsedGustoReport,
  departmentMap: Map<string, string>,
  payrollTaxesAccountId: string,
  tipsAccountId: string,
): GlBucketTotal[] {
  const grossByAccount = new Map<string, number>();
  let totalEmployerTaxCents = 0;
  let totalPaycheckTipsCents = 0;

  for (const employee of parsed.employees) {
    // Employer payroll taxes and Paycheck Tips are each a single
    // company-wide GL bucket — accrued regardless of whether the employee's
    // department resolves to a mapping.
    totalEmployerTaxCents += employee.employerTaxCents;
    totalPaycheckTipsCents += employee.paycheckTipsCents;

    const department = employee.department.trim();
    const chartOfAccountsId = department ? departmentMap.get(department) : undefined;
    if (!chartOfAccountsId) {
      if (!parsed.unmappedDepartments.includes(department)) {
        parsed.unmappedDepartments.push(department);
      }
      continue;
    }

    grossByAccount.set(chartOfAccountsId, (grossByAccount.get(chartOfAccountsId) ?? 0) + employee.grossAmountCents);
  }

  const totals: GlBucketTotal[] = Array.from(grossByAccount.entries()).map(
    ([chartOfAccountsId, amountCents]) => ({ chartOfAccountsId, amountCents, kind: "wages" as const }),
  );

  totals.push({ chartOfAccountsId: payrollTaxesAccountId, amountCents: totalEmployerTaxCents, kind: "employer_tax" });

  if (totalPaycheckTipsCents > 0) {
    totals.push({ chartOfAccountsId: tipsAccountId, amountCents: totalPaycheckTipsCents, kind: "tips" });
  }

  return totals;
}
