import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildXlsx, columnLetter, crc32, escapeXml, sheetName } from "./xlsx";

/** Reads a zip back through its central directory -- independent of the writer's own bookkeeping. */
function unzip(bytes: Buffer): Map<string, string> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
    const crc = bytes.readUInt32LE(at + 16);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const rawSize = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const localOffset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");

    expect(bytes.readUInt32LE(localOffset)).toBe(0x04034b50);
    const dataStart = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const raw = inflateRawSync(bytes.subarray(dataStart, dataStart + compressedSize));
    expect(raw.length).toBe(rawSize);
    expect(crc32(raw)).toBe(crc);

    files.set(name, raw.toString("utf8"));
    at += 46 + nameLength;
  }
  return files;
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("columnLetter", () => {
  it("counts past Z", () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });
});

describe("sheetName", () => {
  it("removes the characters Excel forbids and trims to 31", () => {
    expect(sheetName("P&L: Jan/Feb [draft]?")).toBe("P&L  Jan Feb  draft");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
    expect(sheetName("///")).toBe("Sheet");
  });
});

describe("escapeXml", () => {
  it("escapes markup and drops characters XML cannot carry", () => {
    expect(escapeXml(`Tom & "Jerry" <LLC>`)).toBe("Tom &amp; &quot;Jerry&quot; &lt;LLC&gt;");
    expect(escapeXml("ACH\u0000 DEBIT\u001f")).toBe("ACH DEBIT");
    expect(escapeXml("line one\nline two\ttabbed")).toBe("line one\nline two\ttabbed");
  });
});

describe("buildXlsx", () => {
  const bytes = buildXlsx([
    {
      name: "Profit & Loss",
      freezeRows: 1,
      widths: [30, 12],
      rows: [
        [{ v: "Account", s: "bold" }, { v: "Total", s: "bold" }],
        ["Beer <Sales>", { v: 1234.56, s: "money" }],
        ["    Indented", { v: -10, s: "moneyBold" }],
        [],
        ["Margin", { v: 0.625, s: "percent" }, null, "", { v: null }],
        ["Not a number", Number.NaN],
      ],
    },
    { name: "Profit & Loss", rows: [["second"]] },
  ]);
  const files = unzip(bytes);

  it("is a zip holding every part a workbook needs", () => {
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect([...files.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]);
  });

  it("names the tabs, de-duplicating a repeat", () => {
    const workbook = files.get("xl/workbook.xml")!;
    expect(workbook).toContain(`<sheet name="Profit &amp; Loss" sheetId="1" r:id="rId1"/>`);
    expect(workbook).toContain(`<sheet name="Profit &amp; Loss (2)" sheetId="2" r:id="rId2"/>`);
  });

  it("writes text inline, numbers as numbers, and styles by index", () => {
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain(`<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Account</t></is></c>`);
    expect(sheet).toContain(`<c r="A2" t="inlineStr"><is><t xml:space="preserve">Beer &lt;Sales&gt;</t></is></c>`);
    expect(sheet).toContain(`<c r="B2" s="3"><v>1234.56</v></c>`);
    expect(sheet).toContain(`<c r="B3" s="4"><v>-10</v></c>`);
    expect(sheet).toContain(`<c r="B5" s="6"><v>0.625</v></c>`);
    // Leading spaces survive: they are the statement's indentation.
    expect(sheet).toContain(`<t xml:space="preserve">    Indented</t>`);
  });

  it("leaves empty cells, empty rows and non-finite numbers out", () => {
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).not.toContain(`<row r="4">`);
    expect(sheet).not.toContain(`r="C5"`);
    expect(sheet).not.toContain(`r="D5"`);
    expect(sheet).not.toContain(`r="E5"`);
    expect(sheet).not.toContain("NaN");
    expect(sheet).not.toContain(`r="B6"`);
  });

  it("freezes the header and sets column widths", () => {
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain(`<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`);
    expect(sheet).toContain(`<col min="2" max="2" width="12" customWidth="1"/>`);
    // Element order is part of the schema: views, then columns, then data.
    expect(sheet.indexOf("<sheetViews>")).toBeLessThan(sheet.indexOf("<cols>"));
    expect(sheet.indexOf("<cols>")).toBeLessThan(sheet.indexOf("<sheetData>"));
  });

  it("declares exactly as many cell formats as the styles it hands out", () => {
    const styles = files.get("xl/styles.xml")!;
    const declared = Number(styles.match(/<cellXfs count="(\d+)">/)![1]);
    const actual = styles.split("<cellXfs")[1].split("</cellXfs>")[0].match(/<xf /g)!.length;
    expect(actual).toBe(declared);
    expect(declared).toBe(8);
  });

  it("is deterministic", () => {
    expect(buildXlsx([{ name: "A", rows: [["x", 1]] }]).equals(buildXlsx([{ name: "A", rows: [["x", 1]] }]))).toBe(true);
  });

  it("refuses an empty workbook", () => {
    expect(() => buildXlsx([])).toThrow();
  });
});
