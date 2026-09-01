// lib/production/reviseShipment.ts
//
// Changing what a shipment says actually went out.
//
// Unship, then rebook. Never an in-place quantity edit, for two reasons that both
// have to hold:
//
//   * the units have to come back into cold storage before they can go out again,
//     and the second shipment has to be able to SEE them — otherwise revising 10
//     kegs to 8 fails an availability check against stock the original is still
//     holding;
//
//   * allocation credit is planned, not stored. planShipment decides how much of
//     a shipment lands against a booked contract deposit, how much a soft
//     allocation absorbs, and what spills over as flagged over-delivery. Editing a
//     quantity leaves that plan describing a shipment that no longer exists. A
//     rebook re-runs it, which is also why a revision may move a shipment INTO
//     contract_brewing when a plain edit may not.
//
// The unship half is one plpgsql call (public.reverse_shipment) because it is
// several writes that must not be able to happen separately. The rebook half is
// the ordinary ship path, unchanged — writeColdStorageShipment, the same function
// the Export Bay calls, so a revised shipment is indistinguishable from one that
// was booked correctly the first time.
//
// ORDER MATTERS AND IS NOT REVERSIBLE HALFWAY. The reversal commits before the
// rebook starts. If the rebook then fails, the operator is left with the beer
// back in cold storage and no shipment — recoverable, visible, and the safe
// direction to fail in. The opposite order would double-count stock.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAvailableColdStorageQuantity } from "@/lib/production/coldStorageDepletion";
import { writeColdStorageShipment } from "@/lib/production/shipmentWriter";
import { recheckCommitmentFulfillment } from "@/lib/production/commitmentFulfillment";
import { triggerSquarePush } from "@/lib/production/triggerSquarePush";
import { dedupeWarnings } from "@/lib/production/shipLines";
import type { ShipmentWarning } from "@/lib/production/allocationReserve";
import { isDateInFiledExcisePeriod, filedPeriodExplanation } from "@/lib/production/filedPeriods";
import {
  planShipmentRevision,
  type ShipmentEditRow,
  type ShipmentRevisionPatch,
} from "@/lib/production/shipmentEdit";

export class ReviseShipmentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ReviseShipmentError";
  }
}

export interface ReviseShipmentResult {
  shipmentId: string;
  /** 'delete' when the excise period is open, 'reverse' when it was already filed. */
  mode: "delete" | "reverse";
  /** The negative mirror shipment, when one was written. */
  reversalShipmentId: string | null;
  /** The replacement shipment, or null when the revision was an unship. */
  newShipmentId: string | null;
  unitsRestocked: number;
  created: { batch_id: string; export_transaction_id: string }[];
  /** Reserve advisories from replanning the allocation credits. */
  reserveWarnings: ShipmentWarning[];
  warnings: string[];
}

interface ReverseRpcResult {
  reversed: number;
  restocked: number;
  reversalShipmentId: string | null;
  allocations: string[];
  warnings: string[];
}

/**
 * Revise one shipment.
 *
 * `supabase` must be an admin client: reverse_shipment is SECURITY DEFINER and
 * granted to service_role only, and the rebook writes across cold storage,
 * export transactions and commitments.
 */
export async function reviseShipment(
  supabase: SupabaseClient,
  shipmentId: string,
  patch: ShipmentRevisionPatch,
): Promise<ReviseShipmentResult> {
  // ── Read what is there now ────────────────────────────────────────────────
  const { data: rows, error: readErr } = await supabase
    .from("export_transactions")
    .select(
      "id, channel, status, invoice_id, is_phantom, allocation_id, is_ad_hoc, quantity, recipe_id, recipient_id, recipient_name, notes, created_at",
    )
    .eq("shipment_id", shipmentId)
    .gt("quantity", 0);
  if (readErr) throw new ReviseShipmentError(readErr.message, 500);
  if (!rows || rows.length === 0) throw new ReviseShipmentError("Shipment not found.", 404);

  // ── Legality, from the module both this and the UI read ───────────────────
  const plan = planShipmentRevision(rows as ShipmentEditRow[], patch);
  if (!plan.ok) throw new ReviseShipmentError(plan.error, 409);

  // A shipment spans one recipe (the Ship route takes a single recipe_id), and
  // the rebook needs it. A mixed-recipe shipment could only have come from a
  // hand-written row and there is no sane replanning for it.
  const recipeIds = [...new Set(rows.map((r) => r.recipe_id as string | null).filter(Boolean))];
  if (recipeIds.length !== 1) {
    throw new ReviseShipmentError(
      "This shipment covers more than one recipe, so it cannot be revised as a unit. Unship and rebook it by hand.",
      409,
    );
  }
  const recipeId = recipeIds[0] as string;

  const partnerId = (patch.recipient_id ?? rows[0].recipient_id) as string | null;
  if (!partnerId && !plan.isUnshipOnly) {
    throw new ReviseShipmentError("A recipient is required to rebook this shipment.", 400);
  }

  // ── Which correction is this? A filing fact, not a preference ─────────────
  // The excise worksheets read export_transactions by created_at. If a submitted
  // return already counted these rows, deleting them would restate it silently,
  // so the original stays and a negative mirror dated today nets it out instead.
  const shippedOn = String(rows[0].created_at).slice(0, 10);
  const filing = await isDateInFiledExcisePeriod(supabase, shippedOn);
  const mode: "delete" | "reverse" = filing.isFiled ? "reverse" : "delete";

  const warnings: string[] = [];
  const filingNote = filedPeriodExplanation(filing);
  if (filingNote) warnings.push(filingNote);

  // ── Unship (atomic) ───────────────────────────────────────────────────────
  const { data: rpc, error: rpcErr } = await supabase.rpc("reverse_shipment", {
    p_shipment_id: shipmentId,
    p_mode: mode,
    p_reason: plan.reason,
  });
  if (rpcErr) throw new ReviseShipmentError(`Could not reverse the shipment: ${rpcErr.message}`, 500);

  const reversal = rpc as unknown as ReverseRpcResult;
  warnings.push(...(reversal.warnings ?? []));

  // Everything past here has committed the reversal. Failures below are reported,
  // not thrown, wherever the operator can act on them — the beer is back in cold
  // storage and the ledger is consistent, which is the safe place to stop.

  // ── Commitments ───────────────────────────────────────────────────────────
  // Bidirectional: releasing credit can un-fulfil a commitment the shipment had
  // just satisfied. Run before the rebook so the replanned credits are decided
  // against a truthful fulfilment state.
  for (const allocationId of reversal.allocations ?? []) {
    try {
      await recheckCommitmentFulfillment(supabase, allocationId);
    } catch (e) {
      warnings.push(
        `Commitment fulfilment could not be re-checked for one allocation: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const result: ReviseShipmentResult = {
    shipmentId,
    mode,
    reversalShipmentId: reversal.reversalShipmentId ?? null,
    newShipmentId: null,
    unitsRestocked: Number(reversal.restocked ?? 0),
    created: [],
    reserveWarnings: [],
    warnings,
  };

  if (plan.isUnshipOnly) {
    await triggerSquarePush(supabase, [recipeId], `unship ${shipmentId}`);
    return result;
  }

  // ── Rebook ────────────────────────────────────────────────────────────────
  // Availability is checked AFTER the reversal, because that is when the units
  // are actually back. Every line is checked before anything is written, so one
  // bad line cannot leave a half-booked replacement.
  for (const line of plan.lines) {
    const available = await getAvailableColdStorageQuantity(supabase, {
      recipeId,
      variationId: line.variation_id,
    });
    if (line.quantity > available) {
      throw new ReviseShipmentError(
        `The shipment was reversed and its stock is back in cold storage, but the replacement asks for ${line.quantity} units where only ${available} are on hand. Rebook it from the Export Bay.`,
        422,
      );
    }
  }

  const newShipmentId = crypto.randomUUID();
  const channel = patch.channel ?? (rows[0].channel as string);
  // A correction does not turn an ad-hoc shipment into a booked one. The flag
  // rides along, and the writer still drops it from any row that ends up
  // crediting a commitment — by revision time one may exist that did not
  // before.
  const wasAdHoc = rows.some((r) => (r as { is_ad_hoc?: boolean | null }).is_ad_hoc === true);
  const notes = plan.reason;
  const reserveWarnings: ShipmentWarning[] = [];

  for (const line of plan.lines) {
    try {
      const written = await writeColdStorageShipment(supabase, {
        shipmentId: newShipmentId,
        // Over-delivery fallback only; credited rows take their allocation's own
        // channel, exactly as the Ship route does.
        channel,
        recipeId,
        variationId: line.variation_id,
        quantity: line.quantity,
        recipientId: partnerId,
        recipientName: (rows[0].recipient_name as string | null) ?? null,
        notes,
        credit: partnerId ? { partnerId } : null,
        adHoc: wasAdHoc,
      });
      result.created.push(...written.created);
      reserveWarnings.push(...written.warnings);
    } catch (e) {
      // Earlier lines are committed and are reported back, so the operator can
      // see how far the rebook got rather than reshipping blind.
      throw new ReviseShipmentError(
        `The shipment was reversed, but the replacement only got as far as ${result.created.length} line(s): ${
          e instanceof Error ? e.message : String(e)
        }. Finish it from the Export Bay.`,
        500,
      );
    }
  }

  result.newShipmentId = newShipmentId;
  result.reserveWarnings = dedupeWarnings(reserveWarnings);

  // Same call the Ship route makes, for the same reason: beer moved, and whether
  // Square needs telling now is decided inside the push. No-ops while the gate is
  // shut; never throws.
  await triggerSquarePush(supabase, [recipeId], `revise shipment ${shipmentId}`);

  return result;
}
