import { describe, it, expect } from "vitest";
import { parseCsvRows } from "./csv";

describe("parseCsvRows", () => {
  it("parses a plain header and body", () => {
    expect(parseCsvRows("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("trims surrounding whitespace from cells", () => {
    expect(parseCsvRows("  a , b \n 1 , 2 ")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps a comma inside a quoted field in the same cell", () => {
    // The bug the old chart-of-accounts split(",") had: this used to become
    // four cells and shift every later column one to the left.
    expect(parseCsvRows('name,type\n"Sales, Merchandise",Income')).toEqual([
      ["name", "type"],
      ["Sales, Merchandise", "Income"],
    ]);
  });

  it("treats a doubled quote inside a quoted field as one literal quote", () => {
    expect(parseCsvRows('a\n"He said ""hi"""')).toEqual([["a"], ['He said "hi"']]);
  });

  it("keeps a newline inside a quoted field in the same cell", () => {
    expect(parseCsvRows('a,b\n"line one\nline two",x')).toEqual([
      ["a", "b"],
      ["line one\nline two", "x"],
    ]);
  });

  it("keeps a CRLF inside a quoted field without splitting the record", () => {
    expect(parseCsvRows('a,b\r\n"one\r\ntwo",x')).toEqual([
      ["a", "b"],
      ["one\r\ntwo", "x"],
    ]);
  });

  it("normalizes CRLF record separators", () => {
    expect(parseCsvRows("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("normalizes bare CR record separators", () => {
    expect(parseCsvRows("a,b\r1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("drops records whose cells are all empty", () => {
    expect(parseCsvRows("a,b\n\n1,2\n,\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty cells that sit alongside filled ones", () => {
    expect(parseCsvRows("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  it("returns no rows for empty text", () => {
    expect(parseCsvRows("")).toEqual([]);
    expect(parseCsvRows("\n\n")).toEqual([]);
  });

  it("handles a file with no trailing newline", () => {
    expect(parseCsvRows("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("treats an unterminated quote as running to end of text", () => {
    expect(parseCsvRows('a\n"never closed')).toEqual([["a"], ["never closed"]]);
  });

  it("strips quotes from a fully quoted field", () => {
    expect(parseCsvRows('"a","b"\n"1","2"')).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});
