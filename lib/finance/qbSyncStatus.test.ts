import { describe, it, expect } from "vitest";
import { normalizeQbSyncStatus, qbSyncLabel } from "./qbSyncStatus";

describe("normalizeQbSyncStatus", () => {
  it.each([
    ["SYNCED", "synced"],
    ["BILL_AND_PAYMENT_SYNCED", "synced"],
    ["BILL_SYNCED", "partial"],
    ["SYNC_READY", "ready"],
    ["NOT_SYNC_READY", "not_ready"],
    ["NOT_SYNCED", "not_ready"],
  ] as const)("maps %s -> %s", (raw, expected) => {
    expect(normalizeQbSyncStatus(raw)).toBe(expected);
  });

  it.each([null, undefined, "", "garbage"])("maps %s -> unknown", (raw) => {
    expect(normalizeQbSyncStatus(raw)).toBe("unknown");
  });
});

describe("qbSyncLabel", () => {
  it("labels a synced card as Synced", () => {
    expect(qbSyncLabel("SYNCED", "card")).toBe("Synced");
  });
  it("labels a fully-synced bill as Synced", () => {
    expect(qbSyncLabel("BILL_AND_PAYMENT_SYNCED", "bill")).toBe("Synced");
  });
  it("labels a bill-only sync as Bill only (payment not yet in QB)", () => {
    expect(qbSyncLabel("BILL_SYNCED", "bill")).toBe("Bill only");
  });
  it("labels a sync-ready card as Ready", () => {
    expect(qbSyncLabel("SYNC_READY", "card")).toBe("Ready");
  });
  it("labels an unsynced card as Not synced", () => {
    expect(qbSyncLabel("NOT_SYNC_READY", "card")).toBe("Not synced");
  });
  it("labels an unsynced bill as Not synced", () => {
    expect(qbSyncLabel("NOT_SYNCED", "bill")).toBe("Not synced");
  });
  it("labels null as em dash", () => {
    expect(qbSyncLabel(null, "card")).toBe("—");
  });
});
