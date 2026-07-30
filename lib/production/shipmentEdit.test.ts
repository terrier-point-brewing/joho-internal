// lib/production/shipmentEdit.test.ts
//
// planShipmentEdit is pure, so these drive it directly with row fixtures — no
// Supabase stub. The cases that matter most are the mixed-channel ones: a
// crediting-mode shipment legitimately spans several channels (planCreditedWrites
// stamps each credited row with its OWN allocation's channel), so the edit must
// accept a mixed shipment and collapse it, and must decide "releases credits"
// from allocation_id rather than from the channel value.
import { describe, it, expect } from "vitest";
import {
  planShipmentEdit,
  isShipmentEditable,
  allowedTargetChannels,
  type ShipmentEditRow,
} from "./shipmentEdit";

function row(over: Partial<ShipmentEditRow> = {}): ShipmentEditRow {
  return {
    id: "r1",
    channel: "distribution",
    status: "invoice_required",
    invoice_id: null,
    is_phantom: false,
    allocation_id: null,
    ...over,
  };
}

/** Narrow to the success branch, failing loudly with the guard message if not. */
function expectOk(plan: ReturnType<typeof planShipmentEdit>) {
  if (!plan.ok) throw new Error(`expected ok, got rejection: ${plan.error}`);
  return plan;
}

describe("planShipmentEdit — row-state guards", () => {
  it("G1 rejects when any row is already invoiced", () => {
    const plan = planShipmentEdit(
      [row(), row({ id: "r2", invoice_id: "inv1" })],
      { channel: "wholesale", edit_reason: "wrong channel" },
    );
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toMatch(/invoice/i);
  });

  it("G2 rejects when any row has recorded payment", () => {
    for (const status of ["unpaid", "paid"]) {
      const plan = planShipmentEdit(
        [row(), row({ id: "r2", status })],
        { channel: "wholesale", edit_reason: "wrong channel" },
      );
      expect(plan.ok).toBe(false);
      expect(!plan.ok && plan.error).toMatch(/payment/i);
    }
  });

  it("G3 rejects a taproom shipment", () => {
    const plan = planShipmentEdit(
      [row({ channel: "taproom", status: "paid" })],
      { channel: "distribution", edit_reason: "not taproom" },
    );
    // Taproom rows are also 'paid', so assert the taproom message specifically
    // rather than letting G2 satisfy the test.
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toMatch(/taproom/i);
  });

  it("G6 rejects a phantom row", () => {
    const plan = planShipmentEdit(
      [row(), row({ id: "r2", is_phantom: true })],
      { channel: "wholesale", edit_reason: "wrong channel" },
    );
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toMatch(/phantom/i);
  });

  it("rejects an empty row set", () => {
    const plan = planShipmentEdit([], { channel: "wholesale", edit_reason: "x" });
    expect(plan.ok).toBe(false);
  });
});

describe("planShipmentEdit — patch guards", () => {
  it("G4 rejects taproom as a target", () => {
    const plan = planShipmentEdit([row()], { channel: "taproom", edit_reason: "x" });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toMatch(/taproom/i);
  });

  it("G5 rejects contract_brewing as a target", () => {
    const plan = planShipmentEdit([row()], { channel: "contract_brewing", edit_reason: "x" });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toMatch(/contract/i);
  });

  it("G7 rejects clearing the recipient", () => {
    for (const recipient of [null, ""]) {
      const plan = planShipmentEdit([row()], { recipient_id: recipient });
      expect(plan.ok).toBe(false);
      expect(!plan.ok && plan.error).toMatch(/recipient|customer/i);
    }
  });

  it("G8 rejects a no-op patch", () => {
    const plan = planShipmentEdit([row({ channel: "distribution" })], { channel: "distribution" });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toMatch(/no change/i);
  });

  it("G8 rejects an entirely empty patch", () => {
    const plan = planShipmentEdit([row()], {});
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toMatch(/no change/i);
  });

  it("G9 requires a reason when the channel changes", () => {
    for (const reason of [undefined, null, "", "   "]) {
      const plan = planShipmentEdit([row()], { channel: "wholesale", edit_reason: reason });
      expect(plan.ok).toBe(false);
      expect(!plan.ok && plan.error).toMatch(/reason/i);
    }
  });
});

describe("planShipmentEdit — legal transitions", () => {
  it("distribution → wholesale", () => {
    const plan = expectOk(
      planShipmentEdit([row()], { channel: "wholesale", edit_reason: "miscoded" }),
    );
    expect(plan.updates.channel).toBe("wholesale");
    expect(plan.updates.edit_reason).toBe("miscoded");
    expect(plan.clearsCredits).toBe(false);
    expect(plan.allocationsToRecheck).toEqual([]);
    expect(plan.updates).not.toHaveProperty("allocation_id");
  });

  it("wholesale → distribution", () => {
    const plan = expectOk(
      planShipmentEdit([row({ channel: "wholesale" })], {
        channel: "distribution",
        edit_reason: "miscoded",
      }),
    );
    expect(plan.updates.channel).toBe("distribution");
    expect(plan.clearsCredits).toBe(false);
  });

  it("contract_brewing → distribution releases every distinct allocation, de-duplicated", () => {
    const plan = expectOk(
      planShipmentEdit(
        [
          row({ id: "r1", channel: "contract_brewing", allocation_id: "a1" }),
          row({ id: "r2", channel: "contract_brewing", allocation_id: "a1" }),
          row({ id: "r3", channel: "contract_brewing", allocation_id: "a2" }),
        ],
        { channel: "distribution", edit_reason: "not a contract shipment" },
      ),
    );
    expect(plan.clearsCredits).toBe(true);
    expect([...plan.allocationsToRecheck].sort()).toEqual(["a1", "a2"]);
    expect(plan.updates.allocation_id).toBeNull();
    expect(plan.updates.over_allocation).toBe(false);
  });

  it("accepts a mixed-channel shipment and collapses it to the target", () => {
    // planCreditedWrites can produce exactly this: a contract-credited row plus
    // an over-delivery row stamped with the fallback channel.
    const plan = expectOk(
      planShipmentEdit(
        [
          row({ id: "r1", channel: "contract_brewing", allocation_id: "a1" }),
          row({ id: "r2", channel: "distribution", allocation_id: null }),
        ],
        { channel: "distribution", edit_reason: "rebooked" },
      ),
    );
    expect(plan.updates.channel).toBe("distribution");
    expect(plan.clearsCredits).toBe(true);
    expect(plan.allocationsToRecheck).toEqual(["a1"]);
  });

  it("releases credits from a soft-channel row that still carries an allocation", () => {
    // Proves clearsCredits keys off allocation_id, NOT off the channel value.
    const plan = expectOk(
      planShipmentEdit(
        [row({ channel: "distribution", allocation_id: "a1" })],
        { channel: "wholesale", edit_reason: "rebooked" },
      ),
    );
    expect(plan.clearsCredits).toBe(true);
    expect(plan.allocationsToRecheck).toEqual(["a1"]);
  });

  it("accepts a recipient-only edit with no reason", () => {
    const plan = expectOk(
      planShipmentEdit([row()], { recipient_id: "p2", recipient_name: "Acme" }),
    );
    expect(plan.updates.recipient_id).toBe("p2");
    expect(plan.updates.recipient_name).toBe("Acme");
    expect(plan.updates).not.toHaveProperty("channel");
    expect(plan.clearsCredits).toBe(false);
  });

  it("accepts a notes-only edit with no reason", () => {
    const plan = expectOk(planShipmentEdit([row()], { notes: "left on dock" }));
    expect(plan.updates.notes).toBe("left on dock");
    expect(plan.updates).not.toHaveProperty("channel");
  });

  it("does not release credits when only the recipient changes", () => {
    const plan = expectOk(
      planShipmentEdit(
        [row({ channel: "contract_brewing", allocation_id: "a1" })],
        { recipient_id: "p2" },
      ),
    );
    expect(plan.clearsCredits).toBe(false);
    expect(plan.allocationsToRecheck).toEqual([]);
  });
});

describe("allowedTargetChannels", () => {
  it("offers both soft channels for any editable current set", () => {
    expect(allowedTargetChannels(["distribution"]).sort()).toEqual(["distribution", "wholesale"]);
    expect(allowedTargetChannels(["contract_brewing"]).sort()).toEqual(["distribution", "wholesale"]);
    expect(allowedTargetChannels(["contract_brewing", "distribution"]).sort()).toEqual([
      "distribution",
      "wholesale",
    ]);
  });

  it("offers nothing when taproom is involved", () => {
    expect(allowedTargetChannels(["taproom"])).toEqual([]);
    expect(allowedTargetChannels(["taproom", "distribution"])).toEqual([]);
  });

  it("never offers taproom or contract_brewing", () => {
    for (const input of [["distribution"], ["wholesale"], ["contract_brewing"]]) {
      const out = allowedTargetChannels(input);
      expect(out).not.toContain("taproom");
      expect(out).not.toContain("contract_brewing");
    }
  });
});

describe("isShipmentEditable", () => {
  it("is true for a clean distribution shipment", () => {
    expect(isShipmentEditable([row()])).toBe(true);
  });

  it("agrees with planShipmentEdit on every row-state guard it mirrors", () => {
    const blocked: ShipmentEditRow[][] = [
      [row({ invoice_id: "inv1" })],            // G1
      [row({ status: "unpaid" })],              // G2
      [row({ status: "paid" })],                // G2
      [row({ channel: "taproom", status: "paid" })], // G3
      [row({ is_phantom: true })],              // G6
      [],                                        // empty
    ];
    for (const rows of blocked) {
      expect(isShipmentEditable(rows)).toBe(false);
      // A valid-looking channel patch must be rejected too — the client
      // affordance and the server enforcement must never disagree.
      const plan = planShipmentEdit(rows, { channel: "wholesale", edit_reason: "x" });
      expect(plan.ok).toBe(false);
    }
  });
});
