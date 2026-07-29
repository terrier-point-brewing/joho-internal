import { describe, it, expect } from "vitest";
import {
  rowReconcileState,
  worseReconcileState,
  type ReconcilableRow,
} from "./draftRecountState";

const BATCH = { id: "b1", beer_name: "Wiggo! IPA", batch_number: "B-035" };

function row(over: Partial<ReconcilableRow> = {}): ReconcilableRow {
  return { is_phantom: false, alert_acknowledged_at: null, brew_batches: BATCH, ...over };
}

describe("rowReconcileState", () => {
  it("says nothing about an ordinary batched shipment", () => {
    expect(rowReconcileState(row())).toBeNull();
  });

  it("reports an open phantom as unreconciled", () => {
    expect(rowReconcileState(row({ is_phantom: true, brew_batches: null }))).toBe("unreconciled");
  });

  it("reports a dismissed phantom as no_stock, not as an unexplained row", () => {
    // The regression this module exists for: dismissal stamps only
    // alert_acknowledged_at, so the row stays batchless forever. It must still
    // carry a label once Export Bay has stopped counting it.
    expect(
      rowReconcileState(
        row({ is_phantom: true, brew_batches: null, alert_acknowledged_at: "2026-07-22T22:21:28Z" }),
      ),
    ).toBe("no_stock");
  });

  it("says nothing about a resolved phantom, which gains a batch", () => {
    expect(
      rowReconcileState(
        row({ is_phantom: true, alert_acknowledged_at: "2026-07-22T22:21:28Z" }),
      ),
    ).toBeNull();
  });

  it("treats a null is_phantom as non-phantom", () => {
    expect(rowReconcileState(row({ is_phantom: null, brew_batches: null }))).toBeNull();
  });
});

describe("worseReconcileState", () => {
  it("keeps an open alert visible when collapsed with a dismissed sibling", () => {
    expect(worseReconcileState("no_stock", "unreconciled")).toBe("unreconciled");
    expect(worseReconcileState("unreconciled", "no_stock")).toBe("unreconciled");
  });

  it("keeps a dismissed row visible when collapsed with an ordinary one", () => {
    expect(worseReconcileState(null, "no_stock")).toBe("no_stock");
    expect(worseReconcileState("no_stock", null)).toBe("no_stock");
  });

  it("stays null when neither row has anything to report", () => {
    expect(worseReconcileState(null, null)).toBeNull();
  });

  it("is idempotent on equal states", () => {
    expect(worseReconcileState("unreconciled", "unreconciled")).toBe("unreconciled");
    expect(worseReconcileState("no_stock", "no_stock")).toBe("no_stock");
  });
});
