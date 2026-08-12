import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractGlAccount,
  toRampDatetime,
  normalizeCounterparty,
  getRampAccountBalanceHistory,
  billInWindow,
} from "./ramp";
import type { RampBill } from "./ramp";

describe("toRampDatetime", () => {
  it("expands a bare date to an RFC 3339 datetime (start vs end of day)", () => {
    expect(toRampDatetime("2026-01-01")).toBe("2026-01-01T00:00:00Z");
    expect(toRampDatetime("2026-12-31", true)).toBe("2026-12-31T23:59:59Z");
  });

  it("passes through a value that already has a time component", () => {
    expect(toRampDatetime("2026-01-01T09:30:00Z")).toBe("2026-01-01T09:30:00Z");
  });
});

describe("extractGlAccount", () => {
  it("reads the QuickBooks account number from external_code, not external_id", () => {
    const gl = extractGlAccount({
      line_items: [{
        accounting_field_selections: [{
          id: "opt-1",
          name: "COST OF GOODS SOLD (COGS):Raw Materials",
          external_id: "1150040025",   // Ramp internal id — NOT the account number
          external_code: "5110",        // the QuickBooks account number
          category_info: { type: "GL_ACCOUNT", name: "Category" },
        }],
      }],
    });
    expect(gl).toEqual({
      id: "opt-1",
      external_id: "5110",
      name: "COST OF GOODS SOLD (COGS):Raw Materials",
    });
  });

  it("falls back to external_id when external_code is absent", () => {
    const gl = extractGlAccount({
      accounting_field_selections: [{
        id: "opt-2", name: "Meals", external_id: "6000", external_code: null,
        category_info: { type: "GL_ACCOUNT" },
      }],
    });
    expect(gl?.external_id).toBe("6000");
  });

  it("pulls the SELECTED account, not the dimension descriptor in category_info", () => {
    // Real Ramp shape: `category_info` is the "Category" GL dimension; the chosen
    // account lives on the selection's own top-level id/name/external_id.
    const gl = extractGlAccount({
      accounting_field_selections: [
        {
          category_info: { id: "field-uuid", external_id: "QuickbooksCategory", name: "Category", type: "GL_ACCOUNT" },
          id: "gl-1",
          external_id: "6000",
          name: "Marketing",
        },
      ],
    });
    expect(gl).toEqual({ id: "gl-1", external_id: "6000", name: "Marketing" });
  });

  it("supports the flat (non-nested) selection shape", () => {
    const gl = extractGlAccount({
      accounting_field_selections: [
        { id: "gl-2", external_id: null, name: "Software", type: "GL_ACCOUNT" },
      ],
    });
    expect(gl).toEqual({ id: "gl-2", external_id: null, name: "Software" });
  });

  it("skips non-GL_ACCOUNT dimensions and finds the GL one", () => {
    const gl = extractGlAccount({
      accounting_field_selections: [
        { category_info: { id: "d-field", name: "Department", type: "DEPARTMENT" }, id: "d-1", name: "Sales" },
        { category_info: { id: "gl-field", name: "Category", type: "GL_ACCOUNT" }, id: "gl-3", external_id: "6100", name: "Travel" },
      ],
    });
    expect(gl?.id).toBe("gl-3");
    expect(gl?.name).toBe("Travel");
  });

  it("falls back to line-item selections when none at the top level", () => {
    const gl = extractGlAccount({
      accounting_field_selections: [],
      line_items: [
        { accounting_field_selections: [
          { category_info: { id: "gl-field", name: "Category", type: "GL_ACCOUNT" }, id: "gl-4", external_id: "6200", name: "Utilities" },
        ] },
      ],
    });
    expect(gl?.id).toBe("gl-4");
    expect(gl?.name).toBe("Utilities");
  });

  it("uses external_id then name as the id when Ramp option id is absent", () => {
    expect(extractGlAccount({ accounting_field_selections: [{ external_id: "7000", name: "Rent", type: "GL_ACCOUNT" }] })?.id).toBe("7000");
    expect(extractGlAccount({ accounting_field_selections: [{ name: "Rent", type: "GL_ACCOUNT" }] })?.id).toBe("Rent");
  });

  it("returns null when uncoded or missing identifying info", () => {
    expect(extractGlAccount({})).toBeNull();
    // A GL dimension present but with no account selected on it.
    expect(extractGlAccount({ accounting_field_selections: [{ category_info: { id: "gl-field", name: "Category", type: "GL_ACCOUNT" } }] })).toBeNull();
    expect(extractGlAccount({ accounting_field_selections: [{ type: "GL_ACCOUNT" }] })).toBeNull();
    expect(extractGlAccount({ accounting_field_selections: [{ category_info: { id: "d-field", name: "Department", type: "DEPARTMENT" }, id: "d-1", name: "Sales" }] })).toBeNull();
  });
});

describe("billInWindow", () => {
  const at = (accounting_date: string) => ({ accounting_date } as RampBill);

  it("keeps a bill inside the window and drops one on either side", () => {
    expect(billInWindow(at("2026-07-15T00:00:00Z"), "2026-07-01", "2026-07-31")).toBe(true);
    expect(billInWindow(at("2026-06-30T00:00:00Z"), "2026-07-01", "2026-07-31")).toBe(false);
    expect(billInWindow(at("2026-08-01T00:00:00Z"), "2026-07-01", "2026-07-31")).toBe(false);
  });

  it("treats both bounds as inclusive", () => {
    expect(billInWindow(at("2026-07-01T00:00:00Z"), "2026-07-01", "2026-07-31")).toBe(true);
    expect(billInWindow(at("2026-07-31T23:00:00Z"), "2026-07-01", "2026-07-31")).toBe(true);
  });

  it("keeps every bill when no window is given", () => {
    // rampSync.ts depends on this: it fetches unwindowed so it can refresh the
    // settlement state of bills paid long outside the caller's window.
    expect(billInWindow(at("2020-01-01T00:00:00Z"))).toBe(true);
  });

  /**
   * A bill with no accounting date is still a real debt, and dropping it here
   * would lose it from accounts payable outright with nothing to say so.
   */
  it("keeps a bill that carries no date rather than dropping it", () => {
    expect(billInWindow(at(""), "2026-07-01", "2026-07-31")).toBe(true);
  });
});

describe("normalizeCounterparty", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizeCounterparty("  ERIE   INSURANCE ")).toBe("erie insurance");
    expect(normalizeCounterparty("GUSTO")).toBe("gusto");
    expect(normalizeCounterparty(null)).toBe("");
  });
});

describe("getRampAccountBalanceHistory", () => {
  // Routes the token call and the balance call off the same stub so the
  // module-level token cache behaves as it does in production.
  function stubFetch(payload: unknown, status = 200) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/token")) {
        return { ok: true, json: async () => ({ access_token: "tok", expires_in: 3600 }) };
      }
      return { ok: status < 400, status, json: async () => payload };
    }));
    return calls;
  }

  beforeEach(() => {
    process.env.RAMP_CLIENT_ID = "id";
    process.env.RAMP_CLIENT_SECRET = "secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns cents, converting through the minor-unit rate rather than trusting it is 100", async () => {
    stubFetch({
      data: [
        // USD: the rate IS 100, so `amount` already is cents and passes through.
        { date: "2026-07-30", amount: { amount: 420537, currency_code: "USD", minor_unit_conversion_rate: 100 } },
        // A currency with a different precision must not silently arrive off by
        // a factor of ten. 4205 major units at rate 1 is 420,500 cents.
        { date: "2026-07-31", amount: { amount: 4205, currency_code: "JPY", minor_unit_conversion_rate: 1 } },
      ],
    });

    const history = await getRampAccountBalanceHistory("acct-1", "2026-07-25", "2026-07-31");

    expect(history).toEqual([
      { date: "2026-07-30", balance_cents: 420537, currency_code: "USD" },
      { date: "2026-07-31", balance_cents: 420500, currency_code: "JPY" },
    ]);
  });

  it("sends the window as bare dates on start_date/end_date", async () => {
    const calls = stubFetch({ data: [] });

    await getRampAccountBalanceHistory("acct-1", "2026-07-25", "2026-07-31");

    const balanceCall = calls.find((u) => u.includes("balance-history"))!;
    expect(balanceCall).toContain("/banking/accounts/acct-1/balance-history");
    expect(balanceCall).toContain("start_date=2026-07-25");
    expect(balanceCall).toContain("end_date=2026-07-31");
  });

  it("throws on a Ramp error envelope so the caller can report it", async () => {
    stubFetch({ error_v2: { message: "insufficient scope" } });

    await expect(getRampAccountBalanceHistory("acct-1", "2026-07-25", "2026-07-31")).rejects.toThrow(
      /insufficient scope/,
    );
  });

  it("throws on a non-OK response that carries no error envelope", async () => {
    stubFetch({}, 503);

    await expect(getRampAccountBalanceHistory("acct-1", "2026-07-25", "2026-07-31")).rejects.toThrow(/503/);
  });

  it("tolerates a bare array response and a missing amount", async () => {
    stubFetch([{ date: "2026-07-31T00:00:00Z" }]);

    expect(await getRampAccountBalanceHistory("acct-1", "2026-07-25", "2026-07-31")).toEqual([
      { date: "2026-07-31", balance_cents: 0, currency_code: "USD" },
    ]);
  });
});
