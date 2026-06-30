import { describe, it, expect } from "vitest";
import {
  fmt,
  cents,
  fmtDate,
  fmtDateLong,
  fmtDateTime,
  fmtBbl,
  fmtBbl2,
  fmtUsd,
  fmtCents,
  fmtUsd0,
} from "./formatting";

describe("fmt", () => {
  it("defaults to 3 decimal places", () => {
    expect(fmt(1.23456)).toBe("1.235");
  });

  it("respects an explicit decimal count", () => {
    expect(fmt(1.23456, 1)).toBe("1.2");
    expect(fmt(1.23456, 0)).toBe("1");
  });

  it("pads integers to the requested decimals", () => {
    expect(fmt(2, 3)).toBe("2.000");
  });

  it("formats zero and negatives", () => {
    expect(fmt(0)).toBe("0.000");
    expect(fmt(-1.5, 2)).toBe("-1.50");
  });
});

describe("cents", () => {
  it("divides by 100 with two decimals and no currency symbol", () => {
    expect(cents(1599)).toBe("15.99");
  });

  it("formats zero", () => {
    expect(cents(0)).toBe("0.00");
  });

  it("formats negatives", () => {
    expect(cents(-2500)).toBe("-25.00");
  });

  it("rounds to two decimals", () => {
    expect(cents(1)).toBe("0.01");
    expect(cents(5)).toBe("0.05");
  });
});

describe("fmtDate", () => {
  it("renders a date-only string as 'Mon D' (noon-anchored, TZ-stable)", () => {
    expect(fmtDate("2026-06-03")).toBe("Jun 3");
  });

  it("anchors a date-only string to noon so it does not roll back a day", () => {
    // Jan 1 must stay Jan 1 even in UTC-behind runtimes.
    expect(fmtDate("2026-01-01")).toBe("Jan 1");
  });

  it("leaves a full ISO timestamp's date intact for an explicit UTC value", () => {
    // Midday UTC stays on the same calendar day across US runtime zones.
    expect(fmtDate("2026-12-25T12:00:00Z")).toBe("Dec 25");
  });
});

describe("fmtDateLong", () => {
  it("includes the year", () => {
    expect(fmtDateLong("2026-06-03")).toBe("Jun 3, 2026");
  });

  it("anchors date-only strings to noon", () => {
    expect(fmtDateLong("2026-01-01")).toBe("Jan 1, 2026");
  });
});

describe("fmtDateTime", () => {
  it("includes a date and a time for a UTC-noon timestamp", () => {
    const out = fmtDateTime("2026-06-03T12:00:00Z");
    expect(out).toContain("2026");
    // Has a HH:MM AM/PM time portion.
    expect(out).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
  });
});

describe("fmtBbl", () => {
  it("renders 3 decimals with the BBL suffix", () => {
    expect(fmtBbl(1.23456)).toBe("1.235 BBL");
  });

  it("renders zero", () => {
    expect(fmtBbl(0)).toBe("0.000 BBL");
  });

  it("renders negatives", () => {
    expect(fmtBbl(-2)).toBe("-2.000 BBL");
  });
});

describe("fmtBbl2", () => {
  it("renders 2 decimals with the BBL suffix", () => {
    expect(fmtBbl2(1.236)).toBe("1.24 BBL");
  });

  it("renders zero", () => {
    expect(fmtBbl2(0)).toBe("0.00 BBL");
  });
});

describe("fmtUsd", () => {
  it("delegates to formatCurrency (dollars in)", () => {
    expect(fmtUsd(15.99)).toBe("$15.99");
  });

  it("returns the em-dash sentinel for NaN", () => {
    expect(fmtUsd(NaN)).toBe("—");
  });
});

describe("fmtCents", () => {
  it("delegates to formatCurrencyCents (cents in)", () => {
    expect(fmtCents(1599)).toBe("$15.99");
  });

  it("returns the em-dash sentinel for NaN", () => {
    expect(fmtCents(NaN)).toBe("—");
  });
});

describe("fmtUsd0", () => {
  it("renders a whole-dollar amount with grouping and no decimals", () => {
    expect(fmtUsd0(1234.5)).toBe("$1,235");
  });

  it("renders zero", () => {
    expect(fmtUsd0(0)).toBe("$0");
  });

  it("renders negatives (sign before the dollar sign)", () => {
    // Built from `$${formatNumber(n,0)}`, so the minus lands inside the number.
    expect(fmtUsd0(-50)).toBe("$-50");
  });

  it("returns the em-dash sentinel for non-finite input", () => {
    expect(fmtUsd0(NaN)).toBe("—");
    expect(fmtUsd0(Infinity)).toBe("—");
  });
});
