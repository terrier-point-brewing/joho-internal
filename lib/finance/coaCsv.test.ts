import { describe, it, expect } from "vitest";
import { parseCoaCsv } from "./coaCsv";

const HEADER = "Number,Name,Type,Detail Type,Description,Active";

describe("parseCoaCsv", () => {
  it("parses a standard QBO account row", () => {
    const { rows, warnings } = parseCoaCsv(
      `${HEADER}\n4100,Merchandise Sales,Income,Sales of Product Income,Retail goods,Yes`,
    );
    expect(warnings).toEqual([]);
    expect(rows).toEqual([
      {
        account_name: "Merchandise Sales",
        account_number: "4100",
        account_type: "Income",
        detail_type: "Sales of Product Income",
        description: "Retail goods",
        is_active: true,
      },
    ]);
  });

  it("keeps columns aligned when a quoted field contains a comma", () => {
    // The regression this module exists for: the old split(",") read
    // account_type as "net" here.
    const { rows } = parseCoaCsv(
      `${HEADER}\n4100,"Sales, Merchandise",Income,Sales of Product Income,"Retail, net",Yes`,
    );
    expect(rows[0].account_name).toBe("Sales, Merchandise");
    expect(rows[0].account_type).toBe("Income");
    expect(rows[0].description).toBe("Retail, net");
  });

  it("warns and returns nothing for an empty file", () => {
    expect(parseCoaCsv("")).toEqual({ rows: [], warnings: ["CSV is empty or has no data rows."] });
  });

  it("warns and returns nothing for a header with no data rows", () => {
    expect(parseCoaCsv(HEADER)).toEqual({
      rows: [],
      warnings: ["CSV is empty or has no data rows."],
    });
  });

  it("warns when the account name column is missing", () => {
    const { warnings } = parseCoaCsv("Number,Type\n4100,Income");
    expect(warnings).toContain("Could not find an account name column.");
  });

  it("warns when the account type column is missing", () => {
    const { warnings } = parseCoaCsv("Number,Name\n4100,Merchandise Sales");
    expect(warnings).toContain("Could not find an account type column.");
  });

  it("accepts the alternate header spellings QBO emits", () => {
    const { rows } = parseCoaCsv(
      "Account Number,Account Name,Account Type,Subtype\n1020,Chase Operating,Bank,Checking",
    );
    expect(rows[0]).toMatchObject({
      account_number: "1020",
      account_name: "Chase Operating",
      account_type: "Bank",
      detail_type: "Checking",
    });
  });

  it("matches headers case-insensitively and ignores surrounding space", () => {
    const { rows } = parseCoaCsv("  NAME , tYpE \nCash,Bank");
    expect(rows[0]).toMatchObject({ account_name: "Cash", account_type: "Bank" });
  });

  it("skips rows missing a name or a type, and says how many", () => {
    const { rows, warnings } = parseCoaCsv(
      `${HEADER}\n4100,Merchandise Sales,Income,,,Yes\n4200,,Income,,,Yes\n4300,Orphan,,,,Yes`,
    );
    expect(rows).toHaveLength(1);
    expect(warnings).toContain("2 rows skipped — no account name or no account type.");
  });

  it("uses the singular form when exactly one row is skipped", () => {
    const { warnings } = parseCoaCsv(`${HEADER}\n4100,Sales,Income,,,Yes\n4200,,Income,,,Yes`);
    expect(warnings).toContain("1 row skipped — no account name or no account type.");
  });

  it("treats blank, Yes, true and 1 as active", () => {
    for (const v of ["", "Yes", "yes", "TRUE", "true", "1"]) {
      const { rows } = parseCoaCsv(`Name,Type,Active\nCash,Bank,${v}`);
      expect(rows[0].is_active, `active=${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("treats No and anything else as inactive", () => {
    for (const v of ["No", "no", "false", "0", "archived"]) {
      const { rows } = parseCoaCsv(`Name,Type,Active\nCash,Bank,${v}`);
      expect(rows[0].is_active, `active=${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("returns null rather than empty string for absent optional fields", () => {
    const { rows } = parseCoaCsv("Name,Type\nCash,Bank");
    expect(rows[0]).toMatchObject({
      account_number: null,
      detail_type: null,
      description: null,
    });
  });

  it("ignores columns it does not recognize", () => {
    const { rows, warnings } = parseCoaCsv(
      "Name,Type,Balance,Currency\nCash,Bank,1234.56,USD",
    );
    expect(warnings).toEqual([]);
    expect(rows[0]).toMatchObject({ account_name: "Cash", account_type: "Bank" });
  });

  it("binds a duplicated alias to the first matching column only", () => {
    const { rows } = parseCoaCsv("Name,Account Name,Type\nFirst,Second,Bank");
    expect(rows[0].account_name).toBe("First");
  });

  it("handles CRLF line endings", () => {
    const { rows } = parseCoaCsv(`${HEADER}\r\n4100,Merchandise Sales,Income,,,Yes\r\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0].account_name).toBe("Merchandise Sales");
  });

  it("ignores blank lines between data rows", () => {
    const { rows } = parseCoaCsv(`${HEADER}\n4100,Sales,Income,,,Yes\n\n4200,Other,Income,,,Yes\n`);
    expect(rows).toHaveLength(2);
  });
});
