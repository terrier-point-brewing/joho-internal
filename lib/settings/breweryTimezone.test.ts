import { describe, it, expect } from "vitest";
import {
  DEFAULT_BREWERY_TZ,
  SUPPORTED_TIMEZONES,
  isSupportedTimezone,
  timezoneLabel,
} from "./breweryTimezone";
import { BREWERY_TZ } from "@/lib/utils/datetime";

describe("DEFAULT_BREWERY_TZ", () => {
  it("matches the compile-time fallback zone", () => {
    expect(DEFAULT_BREWERY_TZ).toBe(BREWERY_TZ);
  });

  it("is itself a supported zone (so the fallback is always valid)", () => {
    expect(isSupportedTimezone(DEFAULT_BREWERY_TZ)).toBe(true);
  });
});

describe("SUPPORTED_TIMEZONES", () => {
  it("only contains valid IANA identifiers", () => {
    for (const { value } of SUPPORTED_TIMEZONES) {
      expect(() =>
        new Intl.DateTimeFormat("en-US", { timeZone: value }),
      ).not.toThrow();
    }
  });

  it("has unique values and non-empty labels", () => {
    const values = SUPPORTED_TIMEZONES.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
    for (const { label } of SUPPORTED_TIMEZONES) expect(label.length).toBeGreaterThan(0);
  });
});

describe("isSupportedTimezone", () => {
  it("accepts a supported zone", () => {
    expect(isSupportedTimezone("America/New_York")).toBe(true);
  });

  it("rejects an unsupported or malformed value", () => {
    expect(isSupportedTimezone("Europe/London")).toBe(false);
    expect(isSupportedTimezone("not-a-zone")).toBe(false);
    expect(isSupportedTimezone("")).toBe(false);
    expect(isSupportedTimezone(null)).toBe(false);
    expect(isSupportedTimezone(undefined)).toBe(false);
    expect(isSupportedTimezone(42)).toBe(false);
  });
});

describe("timezoneLabel", () => {
  it("returns the friendly label for a known zone", () => {
    expect(timezoneLabel("America/New_York")).toBe("US Eastern — New York");
  });

  it("falls back to the raw id for an unknown zone", () => {
    expect(timezoneLabel("Europe/London")).toBe("Europe/London");
  });
});
