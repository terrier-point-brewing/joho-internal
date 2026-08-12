// Three behaviours are worth defending here, and the first is the one that
// separates this provider from its treasury twin: a card balance is a LIABILITY
// and must come out negative. The other two are the refusals -- it never
// substitutes a nearby day's figure for a month end, and it never throws, so an
// unreachable Ramp leaves the rest of the balance sheet rendering.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoaAccountRef } from "../../financials/types";

const getRampCardBalance = vi.fn();
vi.mock("@/lib/ramp", () => ({
  getRampCardBalance: (...args: unknown[]) => getRampCardBalance(...args),
}));

const resolveConnection = vi.fn();
const recordSyncResult = vi.fn();
const readDailyBalance = vi.fn();
const readLatestDailyBalance = vi.fn();
vi.mock("../connections", () => ({
  resolveConnection: (...args: unknown[]) => resolveConnection(...args),
  recordSyncResult: (...args: unknown[]) => recordSyncResult(...args),
  readDailyBalance: (...args: unknown[]) => readDailyBalance(...args),
  readLatestDailyBalance: (...args: unknown[]) => readLatestDailyBalance(...args),
}));

vi.mock("@/lib/utils/datetime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils/datetime")>()),
  todayLocalDate: () => "2026-08-12",
}));

import { rampCardBalance } from "./rampCardBalance";
import type { BalanceContext } from "../registry";

const TODAY = "2026-08-12";
/** A month that has ended: answered from the capture taken that day, exactly. */
const CLOSED_PERIOD = "2026-07-31";
/** The month in progress, as the live balance sheet asks for it. */
const OPEN_PERIOD = "2026-08-31";

function ctx(periodEnd: string, config: Record<string, unknown> = { connectionId: "conn-1" }): BalanceContext {
  return {
    supabase: {} as unknown as SupabaseClient as BalanceContext["supabase"],
    coaId: "coa-2110",
    periodEnd,
    config,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    provider: "rampCard",
    label: "Terrier Point Brewing cards",
    externalId: "ramp-business-1",
    config: {},
    status: "active",
    lastSyncedAt: null,
    lastError: null,
    credentials: {},
    ...overrides,
  };
}

/** Ramp's own shape: an amount OWED, reported positive. */
function owed(settledCents: number, pendingCents = settledCents, currency = "USD") {
  return { settled_cents: settledCents, including_pending_cents: pendingCents, currency_code: currency };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveConnection.mockResolvedValue(connection());
  recordSyncResult.mockResolvedValue(undefined);
  readDailyBalance.mockResolvedValue(null);
  readLatestDailyBalance.mockResolvedValue(null);
});

describe("rampCardBalance sign", () => {
  it("reports what Ramp says is owed as a NEGATIVE balance", async () => {
    getRampCardBalance.mockResolvedValue(owed(3_081_39));

    // The entire difference from GL 1030. `credit_card` is a NEGATIVE_SECTION,
    // so a debt Ramp reports as +3,081.39 is stored as -3,081.39. Passed through
    // unflipped it would read as three thousand dollars of value and throw the
    // sheet out by twice that, with a plausible number on screen.
    expect(await rampCardBalance.compute(ctx(OPEN_PERIOD))).toBe(-3_081_39);
  });

  it("counts settled charges only, not pending authorisations", async () => {
    getRampCardBalance.mockResolvedValue(owed(3_081_39, 3_206_24));

    // The books are cash basis and count only cleared card transactions, so a
    // pending authorisation has no expense behind it. Counting it would grow the
    // liability with nothing on the other side of the entry.
    expect(await rampCardBalance.compute(ctx(OPEN_PERIOD))).toBe(-3_081_39);
  });

  it("reports a fully paid card as zero rather than as nothing", async () => {
    getRampCardBalance.mockResolvedValue(owed(0));

    // A confirmed zero is an answer; null would render the account as unsourced
    // and hide the fact that the balance was actually read.
    expect(await rampCardBalance.compute(ctx(OPEN_PERIOD))).toBe(0);
  });
});

describe("rampCardBalance for a month that has ended", () => {
  it("uses the capture dated exactly on the month end and never calls Ramp", async () => {
    readDailyBalance.mockResolvedValue(-2_500_00);

    expect(await rampCardBalance.compute(ctx(CLOSED_PERIOD))).toBe(-2_500_00);
    expect(readDailyBalance).toHaveBeenCalledWith({}, "coa-2110", CLOSED_PERIOD);
    // Ramp answers only about today. Asking it for a July balance in August
    // would return August's figure and store it as July's.
    expect(getRampCardBalance).not.toHaveBeenCalled();
  });

  it("returns null rather than the nearest earlier capture when the month end was missed", async () => {
    readDailyBalance.mockResolvedValue(null);

    expect(await rampCardBalance.compute(ctx(CLOSED_PERIOD))).toBeNull();
    // The whole point. A 27 July balance presented as the July closing figure is
    // plausible, undetectable, wrong, and about to be frozen into the close.
    expect(readLatestDailyBalance).not.toHaveBeenCalled();
  });

  it("treats a period end falling on today as a month that has ended", async () => {
    readDailyBalance.mockResolvedValue(-1);

    await rampCardBalance.compute(ctx(TODAY));

    expect(readDailyBalance).toHaveBeenCalledWith({}, "coa-2110", TODAY);
    expect(getRampCardBalance).not.toHaveBeenCalled();
  });
});

describe("rampCardBalance during the open month", () => {
  it("asks Ramp where the card stands now instead of demanding a future date", async () => {
    getRampCardBalance.mockResolvedValue(owed(412_00));

    // Nothing has captured 31 August and nothing could. Demanding it is what
    // made the Plaid and Ramp feeds read as unsourced from the 1st to the close.
    expect(await rampCardBalance.compute(ctx(OPEN_PERIOD))).toBe(-412_00);
    expect(readDailyBalance).not.toHaveBeenCalled();
  });

  it("falls back to the newest recent capture when Ramp cannot be reached", async () => {
    getRampCardBalance.mockRejectedValue(new Error("Ramp card balance: HTTP 503"));
    readLatestDailyBalance.mockResolvedValue(-300_00);

    expect(await rampCardBalance.compute(ctx(OPEN_PERIOD))).toBe(-300_00);
    // Bounded by the same staleness limit the Plaid feed uses, so a feed that
    // stopped weeks ago goes quiet rather than publishing its last figure.
    expect(readLatestDailyBalance).toHaveBeenCalledWith({}, "coa-2110", TODAY, 7);
    expect(recordSyncResult).toHaveBeenCalledWith(
      {},
      "conn-1",
      expect.objectContaining({ ok: false, error: "Ramp card balance: HTTP 503" }),
    );
  });

  it("returns null when Ramp is unreachable and nothing recent was captured", async () => {
    getRampCardBalance.mockRejectedValue(new Error("Ramp card balance: HTTP 503"));

    // A throw would fail the whole method and skip the account; that is the
    // right response to a half-answer, not to a temporarily unreachable API.
    await expect(rampCardBalance.compute(ctx(OPEN_PERIOD))).resolves.toBeNull();
  });
});

describe("rampCardBalance connection handling", () => {
  it("returns null, not zero, when the account has no connection linked yet", async () => {
    resolveConnection.mockResolvedValue(null);

    expect(await rampCardBalance.compute(ctx(OPEN_PERIOD, {}))).toBeNull();
    expect(getRampCardBalance).not.toHaveBeenCalled();
    // Nothing to report against — there is no connection row to record onto.
    expect(recordSyncResult).not.toHaveBeenCalled();
  });

  it("contributes nothing for a disabled connection without reporting an error", async () => {
    resolveConnection.mockResolvedValue(connection({ status: "disabled" }));

    expect(await rampCardBalance.compute(ctx(OPEN_PERIOD))).toBeNull();
    expect(getRampCardBalance).not.toHaveBeenCalled();
    expect(recordSyncResult).not.toHaveBeenCalled();
  });

  it("returns null when the connection names no Ramp business yet", async () => {
    resolveConnection.mockResolvedValue(connection({ externalId: null }));

    expect(await rampCardBalance.compute(ctx(OPEN_PERIOD))).toBeNull();
    expect(getRampCardBalance).not.toHaveBeenCalled();
    expect(recordSyncResult).toHaveBeenCalledWith({}, "conn-1", expect.objectContaining({ ok: false }));
  });

  it("refuses a non-USD balance instead of summing it into a USD statement", async () => {
    getRampCardBalance.mockResolvedValue(owed(3_081_39, 3_081_39, "CAD"));

    expect(await rampCardBalance.compute(ctx(OPEN_PERIOD))).toBeNull();
    expect(recordSyncResult).toHaveBeenCalledWith(
      {},
      "conn-1",
      expect.objectContaining({ ok: false, error: expect.stringContaining("CAD") }),
    );
  });

  it("records a successful read so Settings can show when it last worked", async () => {
    getRampCardBalance.mockResolvedValue(owed(100));

    await rampCardBalance.compute(ctx(OPEN_PERIOD));

    expect(recordSyncResult).toHaveBeenCalledWith({}, "conn-1", { ok: true });
  });

  it("still returns the balance when recording the outcome fails", async () => {
    getRampCardBalance.mockResolvedValue(owed(777_00));
    recordSyncResult.mockRejectedValue(new Error("status write failed"));

    // Connection health is telemetry. It must not be able to turn a correct
    // balance into a skipped account.
    expect(await rampCardBalance.compute(ctx(OPEN_PERIOD))).toBe(-777_00);
  });
});

describe("rampCardBalance offerability", () => {
  const account = (statementSection: string): CoaAccountRef => ({
    id: "coa-1",
    parentId: null,
    accountName: "Ramp Card",
    accountNumber: "2110",
    statementSection,
  });

  it("is offered on credit card accounts and nowhere else", () => {
    expect(rampCardBalance.appliesTo!(account("credit_card"))).toBe(true);
    // The treasury method's section. Offering this one there would put a debt on
    // an asset account, where the sign flip makes it read as negative cash.
    expect(rampCardBalance.appliesTo!(account("bank"))).toBe(false);
    expect(rampCardBalance.appliesTo!(account("other_current_liabilities"))).toBe(false);
  });

  it("is an integration-kind provider", () => {
    expect(rampCardBalance.kind).toBe("integration");
  });
});
