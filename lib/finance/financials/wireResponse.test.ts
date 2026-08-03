import { describe, it, expect } from "vitest";
import { toWireResponse } from "./wireResponse";
import { isManualAdjustmentRow } from "./manualAdjustment";
import type { FinancialsResponse, FinancialsRow } from "./types";

function row(overrides: Partial<FinancialsRow> = {}): FinancialsRow {
  return {
    coaId: "coa-1",
    parentId: null,
    accountName: "Taproom Beer Sales",
    statementSection: "revenue",
    channel: "taproom",
    posCategory: null,
    kegSize: null,
    amountCentsByMonth: { "2026-08": 1_000 },
    bblByMonth: { "2026-08": 0 },
    bblCoverage: "full",
    mappingSource: "rule",
    sourceRef: { table: "pos_line_items", ids: ["a", "b", "c"] },
    ...overrides,
  };
}

function response(rows: FinancialsRow[]): FinancialsResponse {
  return {
    months: ["2026-08"],
    rows,
    coaAccounts: [],
    dataQuality: {} as FinancialsResponse["dataQuality"],
    kpis: {} as FinancialsResponse["kpis"],
  };
}

describe("toWireResponse", () => {
  it("drops sourceRef.ids from every row", () => {
    const wire = toWireResponse(response([row(), row({ coaId: "coa-2" })]));

    for (const r of wire.rows) expect(r.sourceRef.ids).toBeUndefined();
  });

  it("keeps sourceRef.table, which is what tells a manual adjustment apart", () => {
    // Dropping the whole field would silently un-italicize every operator-entered
    // line on the statement -- manualAdjustment.ts discriminates on the table name.
    const wire = toWireResponse(
      response([row({ sourceRef: { table: "manual_entries", ids: ["m-1"] } }), row()]),
    );

    expect(wire.rows.map((r) => r.sourceRef.table)).toEqual(["manual_entries", "pos_line_items"]);
    expect(wire.rows.map(isManualAdjustmentRow)).toEqual([true, false]);
  });

  it("changes nothing else about a row", () => {
    const original = row();
    const [wired] = toWireResponse(response([original])).rows;

    expect({ ...wired, sourceRef: null }).toEqual({ ...original, sourceRef: null });
  });

  it("carries months, coaAccounts, kpis and dataQuality through untouched", () => {
    const input = response([row()]);
    const wire = toWireResponse(input);

    expect(wire.months).toBe(input.months);
    expect(wire.coaAccounts).toBe(input.coaAccounts);
    expect(wire.kpis).toBe(input.kpis);
    expect(wire.dataQuality).toBe(input.dataQuality);
  });

  it("does not mutate the response it was given", () => {
    const input = response([row()]);
    toWireResponse(input);

    expect(input.rows[0].sourceRef.ids).toEqual(["a", "b", "c"]);
  });
});
