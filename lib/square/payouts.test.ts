import { describe, it, expect, vi, beforeEach } from "vitest";

const squareGetAll = vi.fn();
vi.mock("./client", () => ({ squareGetAll: (...args: unknown[]) => squareGetAll(...args) }));

import { listPayoutsArrivingBetween, sumNetPayoutCents } from "./payouts";

const LOC = { id: "L1", status: "ACTIVE" };

function payout(over: Record<string, unknown>) {
  return {
    id: "po_1",
    status: "PAID",
    arrival_date: "2026-07-10",
    amount_money: { amount: 1000, currency_code: "USD" },
    destination: { type: "SQUARE_STORED_BALANCE" },
    ...over,
  };
}

/** Routes the two endpoints this module calls to their canned responses. */
function respond(locations: unknown[], payouts: unknown[] | ((locationId: string) => unknown[])) {
  squareGetAll.mockImplementation(async (path: string, _key: string, params?: Record<string, string>) => {
    if (path === "/locations") return locations;
    if (path === "/payouts") return typeof payouts === "function" ? payouts(params?.location_id ?? "") : payouts;
    throw new Error(`unexpected path ${path}`);
  });
}

// Braces, not a concise body: mockReset() RETURNS the mock, and vitest treats a
// value returned from beforeEach as a teardown callback -- so it would invoke
// the mock with no arguments after every test.
beforeEach(() => {
  squareGetAll.mockReset();
});

describe("listPayoutsArrivingBetween", () => {
  it("keeps payouts arriving inside the window", async () => {
    respond([LOC], [payout({ id: "a", arrival_date: "2026-07-10" })]);
    const result = await listPayoutsArrivingBetween("2026-06-30", "2026-07-31");
    expect(result.map((p) => p.id)).toEqual(["a"]);
  });

  it("treats the from-date as EXCLUSIVE so the anchor day is never counted twice", async () => {
    // The anchor is the verified balance at the END of 2026-06-30, so that
    // day's settlements are already inside it. Counting them again is the one
    // arithmetic error this whole design is most exposed to.
    respond([LOC], [payout({ id: "on-anchor", arrival_date: "2026-06-30" })]);
    const result = await listPayoutsArrivingBetween("2026-06-30", "2026-07-31");
    expect(result).toEqual([]);
  });

  it("treats the to-date as INCLUSIVE so the month end itself counts", async () => {
    respond([LOC], [payout({ id: "on-end", arrival_date: "2026-07-31" })]);
    const result = await listPayoutsArrivingBetween("2026-06-30", "2026-07-31");
    expect(result.map((p) => p.id)).toEqual(["on-end"]);
  });

  it("filters on arrival date, not on the created_at window the API was queried with", async () => {
    // The API window is padded, so it legitimately returns payouts either side
    // of the period. Trusting the API's own filter would let a payout created
    // on 2026-08-05 land in July's balance.
    respond([LOC], [
      payout({ id: "before", arrival_date: "2026-06-20" }),
      payout({ id: "inside", arrival_date: "2026-07-15" }),
      payout({ id: "after", arrival_date: "2026-08-05" }),
    ]);
    const result = await listPayoutsArrivingBetween("2026-06-30", "2026-07-31");
    expect(result.map((p) => p.id)).toEqual(["inside"]);
  });

  it("pads the queried created_at window on both sides", async () => {
    respond([LOC], []);
    await listPayoutsArrivingBetween("2026-06-30", "2026-07-31");
    const call = squareGetAll.mock.calls.find((c) => c[0] === "/payouts");
    expect(call?.[2].begin_time).toBe("2026-06-16T00:00:00Z");
    expect(call?.[2].end_time).toBe("2026-08-14T00:00:00Z");
  });

  it("drops FAILED payouts", async () => {
    respond([LOC], [payout({ id: "ok" }), payout({ id: "dead", status: "FAILED" })]);
    const result = await listPayoutsArrivingBetween("2026-06-30", "2026-07-31");
    expect(result.map((p) => p.id)).toEqual(["ok"]);
  });

  it("keeps SENT payouts, which are committed but not yet marked paid", async () => {
    respond([LOC], [payout({ id: "sent", status: "SENT" })]);
    const result = await listPayoutsArrivingBetween("2026-06-30", "2026-07-31");
    expect(result.map((p) => p.id)).toEqual(["sent"]);
  });

  it("queries EVERY active location, not just the API's default one", async () => {
    // ListPayouts with no location_id returns the default location only. A
    // second taproom would otherwise stop contributing to the Square balance
    // with no error anywhere -- an understated cash account, invisibly.
    respond(
      [LOC, { id: "L2", status: "ACTIVE" }],
      (locationId) => [payout({ id: `p-${locationId}`, amount_money: { amount: 500 } })],
    );
    const result = await listPayoutsArrivingBetween("2026-06-30", "2026-07-31");
    expect(result.map((p) => p.id).sort()).toEqual(["p-L1", "p-L2"]);
  });

  it("skips inactive locations", async () => {
    respond([LOC, { id: "OLD", status: "INACTIVE" }], (locationId) => [payout({ id: `p-${locationId}` })]);
    const result = await listPayoutsArrivingBetween("2026-06-30", "2026-07-31");
    expect(result.map((p) => p.id)).toEqual(["p-L1"]);
  });

  it("counts a payout returned under two locations only once", async () => {
    respond([LOC, { id: "L2", status: "ACTIVE" }], () => [payout({ id: "same", amount_money: { amount: 700 } })]);
    const result = await listPayoutsArrivingBetween("2026-06-30", "2026-07-31");
    expect(result).toHaveLength(1);
  });

  it("ignores a payout with no arrival date, which cannot be placed in a period", async () => {
    respond([LOC], [payout({ id: "undated", arrival_date: undefined })]);
    expect(await listPayoutsArrivingBetween("2026-06-30", "2026-07-31")).toEqual([]);
  });

  it("returns nothing, and calls no API, for an inverted or empty window", async () => {
    respond([LOC], [payout({})]);
    expect(await listPayoutsArrivingBetween("2026-07-31", "2026-06-30")).toEqual([]);
    expect(await listPayoutsArrivingBetween("2026-07-31", "2026-07-31")).toEqual([]);
    expect(squareGetAll).not.toHaveBeenCalled();
  });
});

describe("sumNetPayoutCents", () => {
  it("sums the net amounts", async () => {
    respond([LOC], [
      payout({ id: "a", amount_money: { amount: 2508 } }),
      payout({ id: "b", amount_money: { amount: 1492 } }),
    ]);
    expect(await sumNetPayoutCents("2026-06-30", "2026-07-31")).toBe(4000);
  });

  it("subtracts a net-refund day, which Square reports as a negative payout", async () => {
    respond([LOC], [
      payout({ id: "in", amount_money: { amount: 10000 } }),
      payout({ id: "refund-day", amount_money: { amount: -38506 } }),
    ]);
    expect(await sumNetPayoutCents("2026-06-30", "2026-07-31")).toBe(-28506);
  });

  it("returns 0 for a window with no settlements, which is not the same as unknown", async () => {
    respond([LOC], []);
    expect(await sumNetPayoutCents("2026-06-30", "2026-07-31")).toBe(0);
  });

  it("propagates a read failure instead of reporting zero movement", async () => {
    squareGetAll.mockRejectedValue(new Error("Square GET /payouts failed"));
    await expect(sumNetPayoutCents("2026-06-30", "2026-07-31")).rejects.toThrow("Square GET /payouts failed");
  });
});
