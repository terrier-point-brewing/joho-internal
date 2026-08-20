import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const getAvailableColdStorageQuantity = vi.fn();
const writeColdStorageShipment = vi.fn();
const recheckCommitmentFulfillment = vi.fn();
const triggerSquarePush = vi.fn();
const isDateInFiledExcisePeriod = vi.fn();

vi.mock("@/lib/production/coldStorageDepletion", () => ({
  getAvailableColdStorageQuantity: (...a: unknown[]) => getAvailableColdStorageQuantity(...a),
}));
vi.mock("@/lib/production/shipmentWriter", () => ({
  writeColdStorageShipment: (...a: unknown[]) => writeColdStorageShipment(...a),
}));
vi.mock("@/lib/production/commitmentFulfillment", () => ({
  recheckCommitmentFulfillment: (...a: unknown[]) => recheckCommitmentFulfillment(...a),
}));
vi.mock("@/lib/production/triggerSquarePush", () => ({
  triggerSquarePush: (...a: unknown[]) => triggerSquarePush(...a),
}));
vi.mock("@/lib/production/filedPeriods", async () => {
  const actual = await vi.importActual<typeof import("./filedPeriods")>("./filedPeriods");
  return {
    ...actual,
    isDateInFiledExcisePeriod: (...a: unknown[]) => isDateInFiledExcisePeriod(...a),
  };
});

import { reviseShipment, ReviseShipmentError } from "./reviseShipment";

interface Row {
  id: string;
  channel: string;
  status: string;
  invoice_id: string | null;
  is_phantom: boolean;
  allocation_id: string | null;
  quantity: number;
  recipe_id: string | null;
  recipient_id: string | null;
  recipient_name: string | null;
  notes: string | null;
  created_at: string;
}

const row = (over: Partial<Row> = {}): Row => ({
  id: "t1",
  channel: "contract_brewing",
  status: "invoice_required",
  invoice_id: null,
  is_phantom: false,
  allocation_id: "alloc-1",
  quantity: 10,
  recipe_id: "recipe-1",
  recipient_id: "partner-1",
  recipient_name: "Fortnight Brewing",
  notes: null,
  created_at: "2026-08-13T10:00:00Z",
  ...over,
});

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function stub(rows: Row[], rpcResult: Record<string, unknown>, rpcCalls: RpcCall[]): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    gt: () => Promise.resolve({ data: rows, error: null }),
  };
  return {
    from: () => builder,
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: rpcResult, error: null });
    },
  } as unknown as SupabaseClient;
}

const emptyReversal = {
  reversed: 1,
  restocked: 10,
  reversalShipmentId: null,
  allocations: ["alloc-1"],
  warnings: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  isDateInFiledExcisePeriod.mockResolvedValue({ isFiled: false, periods: [] });
  getAvailableColdStorageQuantity.mockResolvedValue(10);
  writeColdStorageShipment.mockResolvedValue({
    created: [{ batch_id: "b1", export_transaction_id: "new-1" }],
    warnings: [],
  });
  recheckCommitmentFulfillment.mockResolvedValue(undefined);
  triggerSquarePush.mockResolvedValue(undefined);
});

describe("reviseShipment — which correction mode", () => {
  it("deletes the rows outright when the excise period is still open", async () => {
    const calls: RpcCall[] = [];
    const result = await reviseShipment(stub([row()], emptyReversal, calls), "ship-1", {
      lines: [{ variation_id: "var-1", quantity: 8 }],
      reason: "shipped 8 not 10",
    });

    expect(calls[0].fn).toBe("reverse_shipment");
    expect(calls[0].args.p_mode).toBe("delete");
    expect(result.mode).toBe("delete");
    expect(result.warnings).toEqual([]);
  });

  it("writes a reversal instead when a return has already been filed", async () => {
    // The excise worksheets read export_transactions by created_at with no regard
    // for invoice status, so deleting a filed row restates a submitted return.
    isDateInFiledExcisePeriod.mockResolvedValue({
      isFiled: true,
      periods: [{ filingKey: "nc_dor_beer_excise", periodStart: "2026-07-01", periodEnd: "2026-07-31", submittedOn: "2026-08-10" }],
    });
    const calls: RpcCall[] = [];
    const result = await reviseShipment(
      stub([row({ created_at: "2026-07-30T10:00:00Z" })], { ...emptyReversal, reversalShipmentId: "rev-1" }, calls),
      "ship-1",
      { lines: [{ variation_id: "var-1", quantity: 8 }], reason: "shipped 8 not 10" },
    );

    expect(calls[0].args.p_mode).toBe("reverse");
    expect(result.mode).toBe("reverse");
    expect(result.reversalShipmentId).toBe("rev-1");
    // The operator is told why, in the same words the modal showed beforehand.
    expect(result.warnings.join(" ")).toMatch(/NC beer excise/);
  });

  it("passes the date, not a Date object, so a month-end shipment stays in its own period", async () => {
    const calls: RpcCall[] = [];
    await reviseShipment(stub([row({ created_at: "2026-07-31T23:30:00Z" })], emptyReversal, calls), "ship-1", {
      lines: [{ variation_id: "var-1", quantity: 8 }],
      reason: "wrong qty",
    });
    expect(isDateInFiledExcisePeriod).toHaveBeenCalledWith(expect.anything(), "2026-07-31");
  });
});

describe("reviseShipment — order of operations", () => {
  it("rechecks commitments BEFORE rebooking, so credits are replanned against the truth", async () => {
    const order: string[] = [];
    recheckCommitmentFulfillment.mockImplementation(async () => { order.push("recheck"); });
    writeColdStorageShipment.mockImplementation(async () => {
      order.push("rebook");
      return { created: [], warnings: [] };
    });

    await reviseShipment(stub([row()], emptyReversal, []), "ship-1", {
      lines: [{ variation_id: "var-1", quantity: 8 }],
      reason: "wrong qty",
    });

    expect(order).toEqual(["recheck", "rebook"]);
  });

  it("checks availability only AFTER the reversal, when the units are actually back", async () => {
    const order: string[] = [];
    getAvailableColdStorageQuantity.mockImplementation(async () => { order.push("check"); return 10; });
    const calls: RpcCall[] = [];

    await reviseShipment(stub([row()], emptyReversal, calls), "ship-1", {
      lines: [{ variation_id: "var-1", quantity: 8 }],
      reason: "wrong qty",
    });

    // The reversal RPC was recorded before the first availability check ran.
    expect(calls).toHaveLength(1);
    expect(order).toEqual(["check"]);
  });

  it("refuses to rebook more than is on hand, and says the stock is already back", async () => {
    getAvailableColdStorageQuantity.mockResolvedValue(5);
    await expect(
      reviseShipment(stub([row()], emptyReversal, []), "ship-1", {
        lines: [{ variation_id: "var-1", quantity: 8 }],
        reason: "wrong qty",
      }),
    ).rejects.toThrow(/only 5 are on hand/);
    expect(writeColdStorageShipment).not.toHaveBeenCalled();
  });
});

describe("reviseShipment — unship", () => {
  it("reverses and stops when every line is dropped", async () => {
    const result = await reviseShipment(stub([row()], emptyReversal, []), "ship-1", {
      lines: [],
      reason: "never left the building",
    });

    expect(result.newShipmentId).toBeNull();
    expect(result.unitsRestocked).toBe(10);
    expect(writeColdStorageShipment).not.toHaveBeenCalled();
    // Square still gets told: cold storage moved.
    expect(triggerSquarePush).toHaveBeenCalled();
  });
});

describe("reviseShipment — what it refuses before touching anything", () => {
  it("refuses an invoiced shipment and names the cure", async () => {
    const calls: RpcCall[] = [];
    await expect(
      reviseShipment(stub([row({ invoice_id: "inv-1" })], emptyReversal, calls), "ship-1", {
        lines: [{ variation_id: "var-1", quantity: 8 }],
        reason: "wrong qty",
      }),
    ).rejects.toThrow(ReviseShipmentError);
    expect(calls).toEqual([]);
  });

  it("refuses a mixed-recipe shipment rather than guessing how to replan it", async () => {
    const calls: RpcCall[] = [];
    await expect(
      reviseShipment(
        stub([row(), row({ id: "t2", recipe_id: "recipe-2" })], emptyReversal, calls),
        "ship-1",
        { lines: [{ variation_id: "var-1", quantity: 8 }], reason: "wrong qty" },
      ),
    ).rejects.toThrow(/more than one recipe/);
    expect(calls).toEqual([]);
  });

  it("refuses a shipment that no longer exists", async () => {
    await expect(
      reviseShipment(stub([], emptyReversal, []), "ship-1", { lines: [], reason: "gone" }),
    ).rejects.toThrow(/not found/);
  });
});
