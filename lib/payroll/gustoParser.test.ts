import { describe, it, expect } from "vitest";
import {
  parseGustoPayrollJournal,
  computeGlBucketTotals,
} from "./gustoParser";

// Gusto "Payroll Journal Report" export sample — real structure, real dollar
// amounts and row layout, employee names replaced with fictional ones (see
// .superpowers/sdd/task-2-sample-gusto-payroll-journal.csv; not part of this
// repo; contents copied inline here so the test is self-contained and
// portable across checkouts/CI).
const SAMPLE_CSV = `"Payroll Journal Report"

"TERRIER POINT BREWING LLC"
"4030 Wake Forest Road"
"Ste 349"
"Raleigh","NC","27609"

"Employee Earnings"
"Payroll period"," 06/15/2026 - 06/28/2026"
"Pay day"," 07/01/2026"
"Last Name","First Name","Department","Work Address","Employee Type","Payment","Job","Pay Type","Hours","Rate","Amount","Employee Taxes","Federal Income Tax (Employee)","Social Security (Employee)","Medicare (Employee)","Additional Medicare (Employee)","NC State Tax (Employee)","Employer Taxes","Social Security (Employer)","Medicare (Employer)","FUTA (Employer)","NC Unemployment Tax (Employer)","Net Pay","Reimbursements","Donations","Check Amount","Employer Cost"
"Ashford","Casey","Production","140 Thomas Mill Rd, Holly Springs, NC 27540","Salary/No overtime","Direct Deposit","Brewer","Regular","80.00","29.81","2384.62","458.74","202.31","147.85","34.58","0.00","74.00","227.74","147.85","34.58","0.00","45.31","1925.88","0.00","0.00","1925.88","2612.36"
"","","","","","","Totals","Gross","","","2384.62","","","","","","","","","","","","","","","",""
"Bennett","Riley","Production","140 Thomas Mill Rd, Holly Springs, NC 27540","Salary/Eligible for overtime","Direct Deposit","Brewer","Regular","80.00","20.00","1600.0","275.55","108.15","99.20","23.20","0.00","45.00","162.40","99.20","23.20","9.60","30.40","1324.45","0.00","0.00","1324.45","1762.40"
"","","","","","","Totals","Gross","","","1600.0","","","","","","","","","","","","","","","",""
"Bradford","Morgan","Front of House","140 Thomas Mill Rd, Holly Springs, NC 27540","Paid by the hour","Direct Deposit","","","","","","0.00","","","","","","0.00","","","","","0.00","0.00","0.00","0.00","0.00"
"Carver","Coral","Front of House","140 Thomas Mill Rd, Holly Springs, NC 27540","Paid by the hour","Direct Deposit","Bartender","Regular","8.08","7.00","56.56","9.27","0.00","7.51","1.76","0.00","0.00","12.30","7.51","1.76","0.73","2.30","111.42","0.00","0.00","111.42","132.99"
"","","","","","","Totals","Bonus","","","7.67","","","","","","","","","","","","","","","",""
"","","","","","","","Cash Tips","","","0.54","","","","","","","","","","","","","","","",""
"","","","","","","","Paycheck Tips","","","56.46","","","","","","","","","","","","","","","",""
"","","","","","","","Gross","","","121.23","","","","","","","","","","","","","","","",""
"Hastings","Cody","Front of House","140 Thomas Mill Rd, Holly Springs, NC 27540","Paid by the hour","Direct Deposit","Bartender","Regular","36.22","7.00","253.54","55.52","0.00","40.13","9.39","0.00","6.00","65.70","40.13","9.39","3.88","12.30","589.30","0.00","0.00","589.30","710.52"
"","","","","","","Totals","Cash Tips","","","2.52","","","","","","","","","","","","","","","",""
"","","","","","","","Paycheck Tips","","","391.28","","","","","","","","","","","","","","","",""
"","","","","","","","Gross","","","647.34","","","","","","","","","","","","","","","",""
"Mercer","Camille","Front of House","140 Thomas Mill Rd, Holly Springs, NC 27540","Paid by the hour","Direct Deposit","Bartender","Regular","10.90","7.00","76.3","17.51","0.00","14.19","3.32","0.00","0.00","23.23","14.19","3.32","1.37","4.35","210.18","0.00","0.00","210.18","250.92"
"","","","","","","Totals","Cash Tips","","","1.17","","","","","","","","","","","","","","","",""
"","","","","","","","Paycheck Tips","","","151.39","","","","","","","","","","","","","","","",""
"","","","","","","","Gross","","","228.86","","","","","","","","","","","","","","","",""
"Osei","Aaron","Front of House","140 Thomas Mill Rd, Holly Springs, NC 27540","Paid by the hour","Direct Deposit","Bartender","Regular","43.13","7.00","301.91","72.50","9.14","44.06","10.30","0.00","9.00","72.12","44.06","10.30","4.26","13.50","632.75","0.00","0.00","632.75","777.37"
"","","","","","","Totals","Cash Tips","","","5.36","","","","","","","","","","","","","","","",""
"","","","","","","","Paycheck Tips","","","403.34","","","","","","","","","","","","","","","",""
"","","","","","","","Gross","","","710.61","","","","","","","","","","","","","","","",""
"Sawyer","Val","Production","140 Thomas Mill Rd, Holly Springs, NC 27540","Salary/No overtime","Direct Deposit","Brewer","Regular","80.00","21.63","1730.77","328.62","149.23","107.30","25.09","0.00","47.00","170.92","107.30","25.09","5.65","32.88","1402.15","0.00","0.00","1402.15","1901.69"
"","","","","","","Totals","Gross","","","1730.77","","","","","","","","","","","","","","","",""
"Vance","Kai","Front of House","140 Thomas Mill Rd, Holly Springs, NC 27540","Paid by the hour","Direct Deposit","","","","","","0.00","","","","","","0.00","","","","","0.00","0.00","0.00","0.00","0.00"
"Winters","Aria","Front of House","140 Thomas Mill Rd, Holly Springs, NC 27540","Salary/Eligible for overtime","Direct Deposit","Taproom Manager","Regular","40.00","18.00","720.0","64.08","0.00","44.64","10.44","0.00","9.00","73.08","44.64","10.44","4.32","13.68","655.92","0.00","0.00","655.92","793.08"
"","","","","","","Totals","Gross","","","720.0","","","","","","","","","","","","","","","",""
"Winters","Drew","Front of House","140 Thomas Mill Rd, Holly Springs, NC 27540","Paid by the hour","Direct Deposit","","","","","","0.00","","","","","","0.00","","","","","0.00","0.00","0.00","0.00","0.00"
"Payroll Totals","","","","","","Brewer","Regular","240.00","23.81","5715.39","1281.79","468.83","504.88","118.08","0.00","190.00","807.49","504.88","118.08","29.81","154.72","6852.05","0.00","0.00","6852.05","8941.33"
"","","","","","","Bartender","Regular","98.33","7.00","688.31","","","","","","","","","","","","","","","",""
"","","","","","","Taproom Manager","Regular","40.00","18.00","720.0","","","","","","","","","","","","","","","",""
"","","","","","","Totals","Regular","378.33","18.83","7123.7","","","","","","","","","","","","","","","",""
"","","","","","","","Bonus","","","7.67","","","","","","","","","","","","","","","",""
"","","","","","","","Cash Tips","","","9.59","","","","","","","","","","","","","","","",""
"","","","","","","","Paycheck Tips","","","1002.47","","","","","","","","","","","","","","","",""
"","","","","","","","Gross","","","8143.43","","","","","","","","","","","","","","","",""
`;

const PRODUCTION_COA_ID = "coa-production";
const FOH_COA_ID = "coa-foh";
const TAXES_COA_ID = "coa-payroll-taxes";

function fullDepartmentMap(): Map<string, string> {
  return new Map([
    ["Production", PRODUCTION_COA_ID],
    ["Front of House", FOH_COA_ID],
  ]);
}

describe("parseGustoPayrollJournal", () => {
  it("parses pay period, pay day, and all employee rows (3 Production + 8 Front of House, recounted directly from the file)", () => {
    const parsed = parseGustoPayrollJournal(SAMPLE_CSV);

    expect(parsed.payPeriodStart).toBe("2026-06-15");
    expect(parsed.payPeriodEnd).toBe("2026-06-28");
    expect(parsed.payDay).toBe("2026-07-01");
    expect(parsed.employees).toHaveLength(11);
  });

  it("sums Production gross wages and employer taxes to the verified ground truth", () => {
    const parsed = parseGustoPayrollJournal(SAMPLE_CSV);
    const production = parsed.employees.filter((e) => e.department === "Production");

    expect(production).toHaveLength(3);
    const gross = production.reduce((sum, e) => sum + e.grossAmountCents, 0);
    const tax = production.reduce((sum, e) => sum + e.employerTaxCents, 0);

    expect(gross).toBe(571539);
    expect(tax).toBe(56106);
  });

  it("sums Front of House gross wages (including Carver's Bonus, excluding tips) and employer taxes to the verified ground truth", () => {
    const parsed = parseGustoPayrollJournal(SAMPLE_CSV);
    const foh = parsed.employees.filter((e) => e.department === "Front of House");

    expect(foh).toHaveLength(8);
    const gross = foh.reduce((sum, e) => sum + e.grossAmountCents, 0);
    const tax = foh.reduce((sum, e) => sum + e.employerTaxCents, 0);

    expect(gross).toBe(141598);
    expect(tax).toBe(24643);

    const carver = foh.find((e) => e.lastName === "Carver");
    // 56.56 Regular + 7.67 Bonus = 64.23, i.e. 6423 cents. Cash/Paycheck Tips
    // and the Gross sub-row must NOT be folded in.
    expect(carver?.grossAmountCents).toBe(6423);
    expect(carver?.employerTaxCents).toBe(1230);
  });

  it("keeps $0 Front of House employees (no shifts that period) in the employee list rather than dropping them", () => {
    const parsed = parseGustoPayrollJournal(SAMPLE_CSV);

    const bradford = parsed.employees.find((e) => e.lastName === "Bradford");
    const vance = parsed.employees.find((e) => e.lastName === "Vance");
    // Winters appears twice (Aria + Drew); only Drew is $0.
    const drew = parsed.employees.find((e) => e.lastName === "Winters" && e.firstName === "Drew");

    for (const emp of [bradford, vance, drew]) {
      expect(emp).toBeDefined();
      expect(emp?.grossAmountCents).toBe(0);
      expect(emp?.employerTaxCents).toBe(0);
    }
  });

  it("throws a clear error on empty input", () => {
    expect(() => parseGustoPayrollJournal("")).toThrow();
    expect(() => parseGustoPayrollJournal("   \n  ")).toThrow();
  });

  it("throws a clear error on malformed input with no employee header row", () => {
    expect(() => parseGustoPayrollJournal("not,a,gusto,export\nfoo,bar,baz,qux")).toThrow();
  });
});

describe("computeGlBucketTotals", () => {
  it("buckets gross wages by department and sums employer tax across all departments into the one payroll-taxes account, matching the file's own Payroll Totals row", () => {
    const parsed = parseGustoPayrollJournal(SAMPLE_CSV);
    const totals = computeGlBucketTotals(parsed, fullDepartmentMap(), TAXES_COA_ID);

    const production = totals.find((t) => t.chartOfAccountsId === PRODUCTION_COA_ID);
    const foh = totals.find((t) => t.chartOfAccountsId === FOH_COA_ID);
    const taxes = totals.find((t) => t.chartOfAccountsId === TAXES_COA_ID);

    expect(production?.amountCents).toBe(571539);
    expect(foh?.amountCents).toBe(141598);
    // 561.06 + 246.43 = 807.49 -> matches the file's own "Payroll Totals" row exactly.
    expect(taxes?.amountCents).toBe(80749);
    expect(parsed.unmappedDepartments).toEqual([]);
  });

  it("surfaces an unmapped department without throwing, and excludes its gross dollars from the returned buckets (while still taxing it)", () => {
    // Fixture copy: Carver's department changed to an unmapped value.
    const modifiedCsv = SAMPLE_CSV.replace(
      `"Carver","Coral","Front of House"`,
      `"Carver","Coral","Kitchen"`
    );
    const parsed = parseGustoPayrollJournal(modifiedCsv);
    const departmentMap = fullDepartmentMap(); // no "Kitchen" entry

    const totals = computeGlBucketTotals(parsed, departmentMap, TAXES_COA_ID);

    expect(parsed.unmappedDepartments).toContain("Kitchen");

    const foh = totals.find((t) => t.chartOfAccountsId === FOH_COA_ID);
    // Carver's 64.23 gross must be excluded from Front of House now that her
    // department no longer resolves.
    expect(foh?.amountCents).toBe(141598 - 6423);

    // Employer tax is department-independent — Carver's tax still lands in
    // the one payroll-taxes bucket, so the grand total is unaffected.
    const taxes = totals.find((t) => t.chartOfAccountsId === TAXES_COA_ID);
    expect(taxes?.amountCents).toBe(80749);
  });
});
