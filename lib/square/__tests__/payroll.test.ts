import { describe, it, expect } from "vitest";
import { aggregateDailyTips } from "../payroll";

describe("aggregateDailyTips", () => {
  it("sums tip_money per Eastern day across completed payments", () => {
    const rows = aggregateDailyTips(
      [
        { id: "p1", status: "COMPLETED", created_at: "2026-07-16T15:39:04Z", tip_money: { amount: 300 } },
        { id: "p2", status: "COMPLETED", created_at: "2026-07-16T20:07:47Z", tip_money: { amount: 100 } },
      ],
      []
    );
    expect(rows.find(r => r.date === "2026-07-16")?.tipsPooledCents).toBe(400);
  });

  it("ignores non-COMPLETED payments", () => {
    const rows = aggregateDailyTips(
      [{ id: "p1", status: "FAILED", created_at: "2026-07-16T15:39:04Z", tip_money: { amount: 300 } }],
      []
    );
    expect(rows).toHaveLength(0);
  });

  it("nets a fully refunded tip to zero (reproduces the Andrew Ogden 7/16 case)", () => {
    // $164.95 raw tips for the day, one $100 tip fully refunded moments later
    // as an "Accidental Charge" → Square's own report nets to $64.95.
    const rows = aggregateDailyTips(
      [
        { id: "other", status: "COMPLETED", created_at: "2026-07-16T20:07:47Z", tip_money: { amount: 6495 } },
        { id: "mistaken", status: "COMPLETED", created_at: "2026-07-16T22:35:11Z", tip_money: { amount: 10000 } },
      ],
      [{ payment_id: "mistaken", status: "COMPLETED", amount_money: { amount: 10000 } }]
    );
    expect(rows.find(r => r.date === "2026-07-16")?.tipsPooledCents).toBe(6495);
  });

  it("floors a payment's net tip at zero when the refund exceeds the tip", () => {
    const rows = aggregateDailyTips(
      [{ id: "p1", status: "COMPLETED", created_at: "2026-07-16T20:07:47Z", tip_money: { amount: 500 } }],
      [{ payment_id: "p1", status: "COMPLETED", amount_money: { amount: 11299 } }]
    );
    expect(rows.find(r => r.date === "2026-07-16")?.tipsPooledCents).toBe(0);
  });

  it("only partially nets a refund smaller than the tip", () => {
    const rows = aggregateDailyTips(
      [{ id: "p1", status: "COMPLETED", created_at: "2026-07-16T20:07:47Z", tip_money: { amount: 500 } }],
      [{ payment_id: "p1", status: "COMPLETED", amount_money: { amount: 200 } }]
    );
    expect(rows.find(r => r.date === "2026-07-16")?.tipsPooledCents).toBe(300);
  });

  it("ignores non-COMPLETED refunds", () => {
    const rows = aggregateDailyTips(
      [{ id: "p1", status: "COMPLETED", created_at: "2026-07-16T20:07:47Z", tip_money: { amount: 500 } }],
      [{ payment_id: "p1", status: "PENDING", amount_money: { amount: 500 } }]
    );
    expect(rows.find(r => r.date === "2026-07-16")?.tipsPooledCents).toBe(500);
  });

  it("attributes a refund to the original payment's day, not the refund's own date", () => {
    const rows = aggregateDailyTips(
      [{ id: "p1", status: "COMPLETED", created_at: "2026-07-16T22:35:11Z", tip_money: { amount: 10000 } }],
      [{ payment_id: "p1", status: "COMPLETED", amount_money: { amount: 10000 } }]
    );
    expect(rows.find(r => r.date === "2026-07-16")?.tipsPooledCents).toBe(0);
    expect(rows.find(r => r.date === "2026-07-17")).toBeUndefined();
  });
});
