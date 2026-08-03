/**
 * The financials route is a thin adapter, and the one thing it does beyond
 * delegating is the reason this test exists: it must send the WIRE response,
 * not the computed one. `sourceRef.ids` was 218 KB of a 295 KB P&L payload and
 * nothing in the browser reads it, so a future edit that hands
 * `buildFinancials`' result straight to NextResponse.json would silently put it
 * all back. Asserted against the real serialized body rather than the return
 * value, because JSON is what actually crosses the network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("@/lib/finance/financials/buildFinancials", () => ({ buildFinancials: vi.fn() }));

import { GET } from "./route";
import { buildFinancials } from "@/lib/finance/financials/buildFinancials";
import type { FinancialsResponse, FinancialsRow } from "@/lib/finance/financials/types";

const mockedBuild = vi.mocked(buildFinancials);

function row(overrides: Partial<FinancialsRow> = {}): FinancialsRow {
  return {
    coaId: "coa-1",
    parentId: null,
    accountName: "Taproom Beer Sales",
    statementSection: "revenue",
    channel: "taproom",
    posCategory: null,
    kegSize: null,
    amountCentsByMonth: { "2026-08": 123_456 },
    bblByMonth: { "2026-08": 0 },
    bblCoverage: "full",
    mappingSource: "rule",
    sourceRef: { table: "pos_line_items", ids: ["id-a", "id-b"] },
    ...overrides,
  };
}

function req(qs: string) {
  return new NextRequest(`http://localhost/api/finance/financials?${qs}`);
}

beforeEach(() => {
  mockedBuild.mockReset();
  mockedBuild.mockResolvedValue({
    months: ["2026-08"],
    rows: [row(), row({ coaId: "coa-2", sourceRef: { table: "manual_entries", ids: ["m-1"] } })],
    coaAccounts: [],
    dataQuality: { unmapped: { count: 0, cents: 0, href: "/x" } },
    kpis: { netIncomeCents: { "2026-08": 1 } },
  } as unknown as FinancialsResponse);
});

describe("GET /api/finance/financials", () => {
  it("sends no sourceRef.ids in the serialized body", async () => {
    const body = await (await GET(req("statement=pl&year=2026"))).text();

    expect(body).not.toContain("ids");
    expect(body).not.toContain("id-a");
    for (const r of JSON.parse(body).rows) expect(r.sourceRef.ids).toBeUndefined();
  });

  it("still sends sourceRef.table, the manual-adjustment discriminant", async () => {
    const body = await (await GET(req("statement=pl&year=2026"))).json();

    expect(body.rows.map((r: FinancialsRow) => r.sourceRef.table)).toEqual([
      "pos_line_items",
      "manual_entries",
    ]);
  });

  it("sends the figures, months and KPIs through untouched", async () => {
    const body = await (await GET(req("statement=pl&year=2026"))).json();

    expect(body.months).toEqual(["2026-08"]);
    expect(body.rows[0].amountCentsByMonth).toEqual({ "2026-08": 123_456 });
    expect(body.kpis).toEqual({ netIncomeCents: { "2026-08": 1 } });
    expect(body.dataQuality).toEqual({ unmapped: { count: 0, cents: 0, href: "/x" } });
  });

  it("passes the parsed statement and year to buildFinancials", async () => {
    await GET(req("statement=balance_sheet&year=2025"));

    expect(mockedBuild).toHaveBeenCalledWith({ statement: "balance_sheet", year: 2025 });
  });

  it("rejects a bad statement with a 400 and never calls buildFinancials", async () => {
    const res = await GET(req("statement=nonsense&year=2026"));

    expect(res.status).toBe(400);
    expect(mockedBuild).not.toHaveBeenCalled();
  });
});
