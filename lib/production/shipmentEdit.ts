/**
 * Legality rules for editing a booked shipment (a set of export_transactions
 * rows sharing one shipment_id).
 *
 * This module is the single source of truth for what may be edited, consumed by
 * BOTH the PATCH route (enforcement) and the Shipments tab (affordances), so the
 * UI can never offer an edit the API would reject.
 *
 * Pure — no I/O, no Supabase import — so every guard is unit-testable.
 *
 * Two things are easy to get wrong here:
 *
 *  1. A shipment may legitimately span SEVERAL channels. `planCreditedWrites`
 *     stamps each credited row with its own allocation's channel (which may be
 *     contract_brewing or a soft channel) and stamps over-delivery rows with a
 *     fallback channel. So the edit must accept a mixed shipment and collapse it
 *     to the target, not reject it.
 *
 *  2. Whether an edit releases allocation credits keys off `allocation_id`, NOT
 *     off the row's channel — for the same reason: a credited row can carry a
 *     soft channel.
 */

/** Channels a shipment may be edited between. `taproom` is deliberately absent. */
export type EditableChannel = "distribution" | "wholesale" | "contract_brewing";

/** The soft channels an edit may target. Entering contract_brewing is phase 2. */
const TARGETABLE_CHANNELS: EditableChannel[] = ["distribution", "wholesale"];

/** Statuses that mean money has been recorded against the row. */
const PAID_STATUSES = ["unpaid", "paid"];

/** The subset of an export_transactions row the guards need. */
export interface ShipmentEditRow {
  id: string;
  channel: string;
  status: string;
  invoice_id: string | null;
  is_phantom: boolean | null;
  allocation_id: string | null;
}

/** Fields an operator may change. Omitted keys are left untouched. */
export interface ShipmentEditPatch {
  channel?: string;
  recipient_id?: string | null;
  recipient_name?: string | null;
  notes?: string | null;
  edit_reason?: string | null;
}

export type ShipmentEditPlan =
  | { ok: false; error: string }
  | {
      ok: true;
      /** Column updates to apply to EVERY row in the shipment. */
      updates: Record<string, unknown>;
      /** Distinct allocations to re-check after the update. Empty unless credits are released. */
      allocationsToRecheck: string[];
      /** True when releasing allocation credits — `updates` then clears allocation_id + over_allocation. */
      clearsCredits: boolean;
    };

function reject(error: string): ShipmentEditPlan {
  return { ok: false, error };
}

/**
 * The row-state guards (G1, G2, G3, G6) — the ones that depend only on what the
 * shipment already is, not on what the operator is asking for. Shared by
 * `planShipmentEdit` and `isShipmentEditable` so the two can never disagree.
 */
function rejectOnRowState(rows: ShipmentEditRow[]): string | null {
  if (rows.length === 0) return "Shipment not found.";

  // Checked before G2: taproom rows are also 'paid', and "this is taproom
  // consumption" is the more useful message than "payment recorded".
  if (rows.some((r) => r.channel === "taproom")) {
    return "Taproom consumption is recorded by the POS sync and cannot be re-channelled here.";
  }
  if (rows.some((r) => r.invoice_id)) {
    return "This shipment has already been invoiced. Use the invoice's billing-channel override instead.";
  }
  if (rows.some((r) => PAID_STATUSES.includes(r.status))) {
    return "Payment has already been recorded against this shipment.";
  }
  if (rows.some((r) => r.is_phantom === true)) {
    return "Phantom recount rows have no physical shipment to re-channel.";
  }
  return null;
}

/**
 * The channels an edit may target, given the shipment's current channel set.
 * Returns [] when the shipment is not editable at all.
 */
export function allowedTargetChannels(currentChannels: string[]): EditableChannel[] {
  if (currentChannels.some((c) => c === "taproom")) return [];
  return [...TARGETABLE_CHANNELS];
}

/**
 * Cheap client-side mirror of the row-state guards, for showing or hiding the
 * Edit affordance. A `true` here does not promise a specific patch will be
 * accepted — only that the shipment is editable in principle.
 */
export function isShipmentEditable(rows: ShipmentEditRow[]): boolean {
  return rejectOnRowState(rows) === null;
}

/**
 * Decide whether an edit is legal and, if so, what to write.
 *
 * `updates` applies to every row in the shipment — the target channel collapses
 * a mixed shipment to one channel, which is the intended semantics (the operator
 * is asserting the whole shipment belongs to that channel) and strictly improves
 * invoiceability, since exportInvoicePreview refuses mixed-channel invoices.
 */
export function planShipmentEdit(
  rows: ShipmentEditRow[],
  patch: ShipmentEditPatch,
): ShipmentEditPlan {
  const rowStateError = rejectOnRowState(rows);
  if (rowStateError) return reject(rowStateError);

  const updates: Record<string, unknown> = {};

  // ── Channel ───────────────────────────────────────────────────────────────
  // A channel change is "requested" only if it actually moves at least one row,
  // so re-submitting the current channel is a no-op rather than a reason-gated
  // edit.
  const target = patch.channel;
  const channelChanges = target !== undefined && rows.some((r) => r.channel !== target);

  if (target !== undefined) {
    if (target === "taproom") {
      return reject("A shipment cannot be converted into taproom consumption.");
    }
    if (target === "contract_brewing") {
      return reject(
        "Moving a shipment into contract brewing is not supported — unship and rebook it so its allocation credits are planned correctly.",
      );
    }
    if (!TARGETABLE_CHANNELS.includes(target as EditableChannel)) {
      return reject(`Unknown channel "${target}".`);
    }
    if (channelChanges) updates.channel = target;
  }

  // ── Recipient ─────────────────────────────────────────────────────────────
  if ("recipient_id" in patch) {
    if (!patch.recipient_id) {
      return reject("A recipient is required — every editable channel is invoiced to a customer.");
    }
    updates.recipient_id = patch.recipient_id;
    if ("recipient_name" in patch) updates.recipient_name = patch.recipient_name ?? null;
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  if ("notes" in patch) updates.notes = patch.notes ?? null;

  if (Object.keys(updates).length === 0) {
    return reject("No changes to apply.");
  }

  // ── Reason, required only for a channel change ────────────────────────────
  if (channelChanges && !patch.edit_reason?.trim()) {
    return reject("A reason is required when changing a shipment's channel.");
  }
  if (patch.edit_reason?.trim()) updates.edit_reason = patch.edit_reason.trim();

  // ── Credit release ────────────────────────────────────────────────────────
  // Keyed off allocation_id, not channel: a credited row may carry a soft
  // channel. Only a channel change releases credits — a recipient- or
  // notes-only edit leaves the crediting intact.
  const allocationsToRecheck = channelChanges
    ? [...new Set(rows.map((r) => r.allocation_id).filter((a): a is string => !!a))]
    : [];
  const clearsCredits = allocationsToRecheck.length > 0;

  if (clearsCredits) {
    updates.allocation_id = null;
    // Over-allocation is a property of crediting against a booked deposit; it
    // is meaningless once the row is no longer credited.
    updates.over_allocation = false;
  }

  return { ok: true, updates, allocationsToRecheck, clearsCredits };
}
