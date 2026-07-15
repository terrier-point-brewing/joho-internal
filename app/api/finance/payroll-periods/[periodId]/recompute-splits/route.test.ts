import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn().mockResolvedValue(undefined),
}));

const mockRecompute = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/finance/payrollMatching", () => ({
  recomputePeriodExpenseSplits: (...args: unknown[]) => mockRecompute(...args),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: vi.fn(() => ({})),
}));

describe("POST /api/finance/payroll-periods/[periodId]/recompute-splits", () => {
  beforeEach(() => {
    mockRecompute.mockReset().mockResolvedValue(undefined);
  });

  it("regenerates splits for the period's matched expenses", async () => {
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/api/finance/payroll-periods/P1/recompute-splits", { method: "POST" });

    const res = await POST(req, { params: Promise.resolve({ periodId: "P1" }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(mockRecompute).toHaveBeenCalledWith(expect.anything(), "P1");
  });

  it("wraps a recompute failure via apiError", async () => {
    mockRecompute.mockRejectedValueOnce(new Error("boom"));

    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/api/finance/payroll-periods/P1/recompute-splits", { method: "POST" });

    const res = await POST(req, { params: Promise.resolve({ periodId: "P1" }) });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({ error: "boom" });
  });
});
